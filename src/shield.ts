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
  ttlMs?: number;
  staleTtlMs?: number;
  beta?: number;
  onBackgroundError?: (error: unknown, key: string) => void | Promise<void>;
}

interface MemoryEntry<T> {
  envelope: ShieldEnvelope<T>;
  expiresAt: number;
}

interface NormalizedShieldOptions<T> {
  ttlMs: number;
  staleTtlMs: number;
  beta: number;
  timeoutMs?: number;
  maxFlightWindowMs?: number;
  clone?: ShieldOptions<T>['clone'];
  onBackgroundError?: ShieldOptions<T>['onBackgroundError'];
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

    validateDuration('ttlMs', ttlMs);
    validateDuration('staleTtlMs', staleTtlMs);
    validateDuration('timeoutMs', options.timeoutMs);
    validateDuration('maxFlightWindowMs', options.maxFlightWindowMs);

    if (!Number.isFinite(beta) || beta < 0) {
      throw new RangeError('beta must be a finite, non-negative number');
    }

    if (!Number.isFinite(ttlMs + staleTtlMs)) {
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
    const expiry = Date.now() + options.ttlMs;
    const envelope: ShieldEnvelope<T> = {
      value,
      deltaMs,
      expiry,
      staleExpiry: expiry + options.staleTtlMs,
    };

    await this.cache.set(key, envelope, options.ttlMs + options.staleTtlMs);
    return value;
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

    void refresh
      .catch((error: unknown) =>
        this.reportBackgroundError(key, error, options.onBackgroundError),
      )
      .finally(() => {
        this.backgroundRefreshes.delete(key);
      });
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
