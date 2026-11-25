import type { FlightOptions } from './singleflight.js';
import { defaultSingleFlight, SingleFlight } from './singleflight.js';

/**
 * Envelope stored inside a CacheAdapter.
 *
 * - `value`       – the cached payload.
 * - `deltaMs`     – how long the previous loader took (ms). Used by XFetch (beta).
 * - `expiry`      – soft expiry (Date.now() + ttlMs).  After this, data is "stale".
 * - `staleExpiry` – hard expiry (expiry + staleTtlMs). After this, data is gone.
 *
 * **For adapter authors:** When persisting to Redis or another external store,
 * set the **physical key TTL** (e.g. Redis `PX`) to the `pxMs` argument of
 * `CacheAdapter.set()`, **not** `envelope.expiry`.  `pxMs` already equals
 * `ttlMs + staleTtlMs`, i.e. the total time the entry must remain stored so
 * that the stale-serving window works correctly.
 */
export interface ShieldEnvelope<T> {
  value: T;
  deltaMs: number;
  expiry: number;
  staleExpiry: number;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * CacheAdapter — the contract custom cache backends must implement.
 *
 * `pxMs` in `set()` is the **hard storage lifetime** in milliseconds
 * (= `ttlMs + staleTtlMs`).  Use this — not `envelope.expiry` — when setting
 * the physical TTL on your store (e.g. `await redis.set(key, json, 'PX', pxMs)`).
 * `envelope.expiry` is the *soft* expiry used internally by StampedeShield to
 * decide when data becomes stale; the entry must stay alive in the store for
 * the full `pxMs` window so stale-serving can work.
 */
export interface CacheAdapter<T> {
  get(key: string): MaybePromise<ShieldEnvelope<T> | null | undefined>;
  set(key: string, envelope: ShieldEnvelope<T>, pxMs: number): MaybePromise<void>;
  delete(key: string): MaybePromise<void>;
}

export interface ShieldOptions<T> extends FlightOptions<T> {
  /**
   * How long (ms) a freshly loaded value is considered valid.
   *
   * Accepts a **static number** or a **function** that receives the loaded
   * value and returns a number.  Use the function form to implement
   * conditional TTLs — e.g. cache a `null` miss for only 5 s while caching a
   * real object for 5 min:
   *
   * ```ts
   * ttlMs: (val) => val === null ? 5_000 : 300_000
   * ```
   *
   * @default 60_000
   */
  ttlMs?: number | ((value: T) => number);

  /** How long (ms) a stale value may still be served while a background
   *  refresh is running.  Set to `0` to disable stale-while-revalidate.
   * @default 0
   */
  staleTtlMs?: number;

  /**
   * XFetch early-expiry aggressiveness.  Higher values trigger background
   * refreshes earlier (before the TTL expires).  `0` disables early refresh.
   * @default 1
   */
  beta?: number;

  /**
   * Called when a background (stale-while-revalidate) refresh fails.
   * If omitted, errors are silently swallowed so callers still receive stale data.
   */
  onBackgroundError?: (error: unknown, key: string) => void | Promise<void>;

  /**
   * Predicate called **after** the loader resolves.  Return `false` to skip
   * caching the result (e.g. cache misses, error sentinels, or partial data):
   *
   * ```ts
   * shouldCache: (val) => val !== null
   * ```
   *
   * When `false` is returned the value is still returned to the caller — it
   * just never enters the cache, so the next call will invoke the loader again.
   */
  shouldCache?: (value: T) => boolean;

  /**
   * Serverless / edge-runtime hook.  Pass the platform's `waitUntil` function
   * so that background SWR refreshes are kept alive after the HTTP response is
   * sent.  Without this, runtimes like Vercel, Cloudflare Workers and
   * Next.js App Router will kill the in-flight refresh promise:
   *
   * ```ts
   * // Next.js App Router / Vercel
   * import { unstable_after as waitUntil } from 'next/server';
   * shield.getOrSet(key, loader, { waitUntil });
   *
   * // Cloudflare Workers
   * shield.getOrSet(key, loader, { waitUntil: ctx.waitUntil.bind(ctx) });
   * ```
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

interface MemoryEntry<T> {
  envelope: ShieldEnvelope<T>;
  expiresAt: number;
}

interface NormalizedShieldOptions<T> {
  ttlMs: number | ((value: T) => number);
  staleTtlMs: number;
  beta: number;
  timeoutMs?: number;
  maxFlightWindowMs?: number;
  clone?: ShieldOptions<T>['clone'];
  onBackgroundError?: ShieldOptions<T>['onBackgroundError'];
  shouldCache?: ShieldOptions<T>['shouldCache'];
  waitUntil?: ShieldOptions<T>['waitUntil'];
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_STALE_TTL_MS = 0;
const DEFAULT_BETA = 1;

function validateDuration(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError(`${name} must be a finite, non-negative number`);
  }
}

/**
 * Bug 1.2 fix: Safe clone that catches DataCloneError from structuredClone
 * and falls back to JSON round-trip, then identity.
 */
function cloneValue<T>(value: T, clone: ShieldOptions<T>['clone']): T {
  if (clone === true) {
    try {
      return structuredClone(value);
    } catch {
      try {
        return JSON.parse(JSON.stringify(value)) as T;
      } catch {
        return value;
      }
    }
  }
  if (typeof clone === 'function') {
    return clone(value);
  }
  return value;
}

export class MemoryCacheAdapter<T> implements CacheAdapter<T> {
  readonly maxEntries: number;
  private readonly entries = new Map<string, MemoryEntry<T>>();

  constructor(maxEntries?: number);
  constructor(options?: { maxEntries?: number });
  constructor(maxEntriesOrOptions: number | { maxEntries?: number } = 1_000) {
    const maxEntries = typeof maxEntriesOrOptions === 'number'
      ? maxEntriesOrOptions
      : maxEntriesOrOptions.maxEntries ?? 1_000;

    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive safe integer');
    }

    this.maxEntries = maxEntries;
  }

  get size(): number {
    this.removeExpired();
    return this.entries.size;
  }

  get(key: string): ShieldEnvelope<T> | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.envelope;
  }

  set(key: string, envelope: ShieldEnvelope<T>, pxMs: number): void {
    validateDuration('pxMs', pxMs);

    if (pxMs === 0) {
      this.entries.delete(key);
      return;
    }

    this.entries.delete(key);
    this.entries.set(key, {
      envelope,
      expiresAt: Date.now() + pxMs,
    });

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private removeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}

type ShieldLoader<T> = (signal: AbortSignal) => Promise<T>;

export class StampedeShield<T> {
  readonly cache: CacheAdapter<T>;
  readonly singleFlight: SingleFlight;
  private readonly backgroundRefreshes = new Set<string>();

  constructor(
    cache: CacheAdapter<T> = new MemoryCacheAdapter<T>(),
    singleFlightInstance: SingleFlight = defaultSingleFlight,
  ) {
    this.cache = cache;
    this.singleFlight = singleFlightInstance;
  }

  async getOrSet(
    key: string,
    loader: ShieldLoader<T>,
    options: ShieldOptions<T> = {},
  ): Promise<T> {
    const normalized = this.normalizeOptions(options);
    const envelope = await this.cache.get(key);
    const now = Date.now();

    if (envelope !== null && envelope !== undefined) {
      if (now < envelope.expiry) {
        // Bug 2.2 fix: Clamp Math.random() away from 0 so Math.log() never
        // returns -Infinity, and clamp deltaMs so 0 * -Infinity never yields NaN.
        const safeRandom = Math.max(Number.EPSILON, Math.random());
        const safeDelta  = Math.max(1, envelope.deltaMs);
        const shouldRefresh =
          now - safeDelta * normalized.beta * Math.log(safeRandom) >= envelope.expiry;

        if (shouldRefresh) {
          this.startBackgroundRefresh(key, loader, normalized);
        }

        return cloneValue(envelope.value, normalized.clone);
      }

      if (now < envelope.staleExpiry) {
        this.startBackgroundRefresh(key, loader, normalized);
        return cloneValue(envelope.value, normalized.clone);
      }
    }

    const value = await this.singleFlight.do(
      key,
      (signal) => this.loadAndStore(key, loader, normalized, signal),
      this.flightOptions(normalized),
    );

    return cloneValue(value, normalized.clone);
  }

  private normalizeOptions(options: ShieldOptions<T>): NormalizedShieldOptions<T> {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const staleTtlMs = options.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
    const beta = options.beta ?? DEFAULT_BETA;

    // Static ttlMs is validated eagerly; function form is validated lazily in loadAndStore.
    if (typeof ttlMs === 'number') {
      validateDuration('ttlMs', ttlMs);
    } else if (typeof ttlMs !== 'function') {
      throw new TypeError('ttlMs must be a number or a function returning a number');
    }

    validateDuration('staleTtlMs', staleTtlMs);
    validateDuration('timeoutMs', options.timeoutMs);
    validateDuration('maxFlightWindowMs', options.maxFlightWindowMs);

    if (!Number.isFinite(beta) || beta < 0) {
      throw new RangeError('beta must be a finite, non-negative number');
    }

    if (typeof ttlMs === 'number' && !Number.isFinite(ttlMs + staleTtlMs)) {
      throw new RangeError('ttlMs + staleTtlMs must be finite');
    }

    return {
      ttlMs,
      staleTtlMs,
      beta,
      timeoutMs: options.timeoutMs,
      maxFlightWindowMs: options.maxFlightWindowMs,
      clone: options.clone,
      onBackgroundError: options.onBackgroundError,
      shouldCache: options.shouldCache,
      waitUntil: options.waitUntil,
    };
  }

  private flightOptions(options: NormalizedShieldOptions<T>): FlightOptions<T> {
    return {
      timeoutMs: options.timeoutMs,
      maxFlightWindowMs: options.maxFlightWindowMs,
    };
  }

  private async loadAndStore(
    key: string,
    loader: ShieldLoader<T>,
    options: NormalizedShieldOptions<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const startedAt = performance.now();
    const value = await loader(signal);
    // Bug 2.2 fix: Clamp deltaMs to at least 1ms so XFetch never gets
    // 0 * Math.log(x) = NaN for sub-millisecond loaders.
    const deltaMs = Math.max(1, performance.now() - startedAt);

    // shouldCache: skip writing to cache if predicate returns false.
    // The value is still returned to the caller — just not stored.
    if (options.shouldCache !== undefined && !options.shouldCache(value)) {
      return value;
    }

    // Dynamic ttlMs: resolve the function form now that we have the value.
    const resolvedTtlMs = typeof options.ttlMs === 'function'
      ? options.ttlMs(value)
      : options.ttlMs;

    validateDuration('ttlMs (dynamic)', resolvedTtlMs);

    // If dynamic ttlMs resolves to 0, skip caching (treat as "never cache").
    if (resolvedTtlMs === 0) {
      return value;
    }

    const expiry = Date.now() + resolvedTtlMs;
    const envelope: ShieldEnvelope<T> = {
      value,
      deltaMs,
      expiry,
      staleExpiry: expiry + options.staleTtlMs,
    };

    await this.cache.set(key, envelope, resolvedTtlMs + options.staleTtlMs);
    return value;
  }

  /**
   * Stampede-safe cache invalidation.
   *
   * Unlike `cache.delete(key)` — which removes the entry entirely and causes a
   * thundering-herd on the next burst — `softPurge` zeroes out only the *fresh*
   * window (`expiry = 0`) while leaving the *stale* window intact.
   *
   * Result: the **very next** `getOrSet` call finds the entry stale, triggers
   * exactly **one** coalesced background refresh via `startBackgroundRefresh`,
   * and immediately returns the stale value to all concurrent callers.
   * No stampede. No blocking.
   *
   * Use this after a DB mutation instead of `cache.delete`:
   *
   * ```ts
   * await db.updateProduct(id, data);
   * await shield.softPurge(`product:${id}`);
   * // next read returns stale instantly, refreshes once in background
   * ```
   */
  async softPurge(key: string): Promise<void> {
    const envelope = await this.cache.get(key);
    if (envelope === null || envelope === undefined) {
      return; // Nothing cached — no-op.
    }

    // Zero-out the fresh window so the entry is immediately stale,
    // but keep staleExpiry alive so callers still get a value to serve.
    const purged: ShieldEnvelope<T> = {
      value: envelope.value,
      deltaMs: envelope.deltaMs,
      expiry: 0,                      // ← marks as stale immediately
      staleExpiry: envelope.staleExpiry,
    };

    const remainingPxMs = Math.max(0, envelope.staleExpiry - Date.now());
    if (remainingPxMs === 0) {
      await this.cache.delete(key);
      return;
    }

    await this.cache.set(key, purged, remainingPxMs);
  }

  private startBackgroundRefresh(
    key: string,
    loader: ShieldLoader<T>,
    options: NormalizedShieldOptions<T>,
  ): void {
    if (this.backgroundRefreshes.has(key)) {
      return;
    }

    this.backgroundRefreshes.add(key);

    let refresh: Promise<T>;
    try {
      refresh = this.singleFlight.do(
        key,
        (signal) => this.loadAndStore(key, loader, options, signal),
        this.flightOptions(options),
      );
    } catch (error) {
      this.backgroundRefreshes.delete(key);
      void this.reportBackgroundError(key, error, options.onBackgroundError);
      return;
    }

    const work = refresh
      .catch((error: unknown) =>
        this.reportBackgroundError(key, error, options.onBackgroundError),
      )
      .finally(() => {
        this.backgroundRefreshes.delete(key);
      });

    // waitUntil: hand the promise to the platform (Vercel / Cloudflare Workers /
    // Next.js App Router) so it stays alive after the HTTP response is sent.
    // Without this, serverless runtimes kill the in-flight refresh immediately.
    if (options.waitUntil !== undefined) {
      options.waitUntil(work);
    }
  }

  private async reportBackgroundError(
    key: string,
    error: unknown,
    handler: ShieldOptions<T>['onBackgroundError'],
  ): Promise<void> {
    if (handler === undefined) {
      return;
    }

    try {
      await handler(error, key);
    } catch {
      // Error hooks must not become unhandled background rejections.
    }
  }
}
