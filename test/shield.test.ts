import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryCacheAdapter,
  SingleFlight,
  StampedeShield,
} from '../src/index.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StampedeShield', () => {
  it('coalesces 50 cold cache misses into one loader call', async () => {
    const cache = new MemoryCacheAdapter<{ value: string }>();
    const shield = new StampedeShield(cache, new SingleFlight());
    let loaderCalls = 0;

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        shield.getOrSet(
          'cold-key',
          async () => {
            loaderCalls += 1;
            await delay(10);
            return { value: 'ready' };
          },
          { ttlMs: 1_000, staleTtlMs: 1_000 },
        ),
      ),
    );

    expect(loaderCalls).toBe(1);
    expect(results).toHaveLength(50);
    expect(results.every((result) => result.value === 'ready')).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('refreshes early with XFetch once while readers receive the cached value immediately', async () => {
    const cache = new MemoryCacheAdapter<string>();
    const shield = new StampedeShield(cache, new SingleFlight());
    let loaderCalls = 0;
    let releaseRefresh!: (value: string) => void;
    const refresh = new Promise<string>((resolve) => {
      releaseRefresh = resolve;
    });

    const loader = async (): Promise<string> => {
      loaderCalls += 1;
      if (loaderCalls === 1) {
        return 'cached';
      }
      return refresh;
    };

    await shield.getOrSet('xfetch-key', loader, {
      ttlMs: 1_000,
      staleTtlMs: 1_000,
    });

    const envelope = cache.get('xfetch-key');
    expect(envelope).toBeDefined();
    const now = vi.spyOn(Date, 'now').mockReturnValue(envelope!.expiry - 1);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const startedAt = performance.now();

    const readers = await Promise.all(
      Array.from({ length: 20 }, () =>
        shield.getOrSet('xfetch-key', loader, {
          ttlMs: 1_000,
          staleTtlMs: 1_000,
        }),
      ),
    );

    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeLessThan(10);
    expect(readers).toEqual(Array.from({ length: 20 }, () => 'cached'));

    await flushAsyncWork();
    expect(loaderCalls).toBe(2);

    releaseRefresh('refreshed');
    await flushAsyncWork();
    expect(cache.get('xfetch-key')?.value).toBe('refreshed');
    expect(loaderCalls).toBe(2);

    now.mockRestore();
    random.mockRestore();
  });

  it('serves stale data when background refresh fails and reports the error', async () => {
    const cache = new MemoryCacheAdapter<string>();
    const shield = new StampedeShield(cache, new SingleFlight());
    let loaderCalls = 0;
    const failure = new Error('upstream unavailable');
    const onBackgroundError = vi.fn();

    await shield.getOrSet(
      'stale-key',
      async () => {
        loaderCalls += 1;
        return 'stale-value';
      },
      { ttlMs: 100, staleTtlMs: 1_000 },
    );

    const envelope = cache.get('stale-key');
    expect(envelope).toBeDefined();
    const now = vi.spyOn(Date, 'now').mockReturnValue(envelope!.expiry + 1);

    await expect(
      shield.getOrSet(
        'stale-key',
        async () => {
          loaderCalls += 1;
          throw failure;
        },
        {
          ttlMs: 100,
          staleTtlMs: 1_000,
          onBackgroundError,
        },
      ),
    ).resolves.toBe('stale-value');

    await flushAsyncWork();
    expect(loaderCalls).toBe(2);
    expect(onBackgroundError).toHaveBeenCalledWith(failure, 'stale-key');
    expect(cache.get('stale-key')?.value).toBe('stale-value');

    now.mockRestore();
  });

  it('evicts the least recently used memory entry at the bound', () => {
    const cache = new MemoryCacheAdapter<string>(2);
    const envelope = (value: string): { value: string; deltaMs: number; expiry: number; staleExpiry: number } => ({
      value,
      deltaMs: 1,
      expiry: Date.now() + 1_000,
      staleExpiry: Date.now() + 2_000,
    });

    cache.set('first', envelope('first'), 1_000);
    cache.set('second', envelope('second'), 1_000);
    expect(cache.get('first')?.value).toBe('first');
    cache.set('third', envelope('third'), 1_000);

    expect(cache.get('first')?.value).toBe('first');
    expect(cache.get('second')).toBeUndefined();
    expect(cache.get('third')?.value).toBe('third');
  });

  // =========================================================================
  // Bug 2.1 — Background Refresh Stampede Prevention
  // =========================================================================

  it('Bug 2.1: 100 stale reads trigger exactly 1 background loader, not 100', async () => {
    const cache = new MemoryCacheAdapter<string>();
    const sf = new SingleFlight();
    const shield = new StampedeShield(cache, sf);
    let loaderCalls = 0;

    // Prime the cache
    await shield.getOrSet(
      'stampede-key',
      async () => {
        loaderCalls += 1;
        return 'initial';
      },
      { ttlMs: 100, staleTtlMs: 5_000 },
    );
    expect(loaderCalls).toBe(1);

    // Move time past soft expiry into stale window
    const envelope = cache.get('stampede-key');
    expect(envelope).toBeDefined();
    const mockNow = vi.spyOn(Date, 'now').mockReturnValue(envelope!.expiry + 1);

    let resolveRefresh!: (v: string) => void;
    const refreshPromise = new Promise<string>((r) => { resolveRefresh = r; });

    const staleLoader = async (): Promise<string> => {
      loaderCalls += 1;
      return refreshPromise;
    };

    // Fire 100 stale reads concurrently
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        shield.getOrSet('stampede-key', staleLoader, {
          ttlMs: 100,
          staleTtlMs: 5_000,
        }),
      ),
    );

    // All 100 readers get the stale value immediately
    expect(results.every((r) => r === 'initial')).toBe(true);

    // Only 1 background refresh was started (not 100)
    await flushAsyncWork();
    expect(loaderCalls).toBe(2); // 1 initial + 1 background

    resolveRefresh('refreshed');
    await flushAsyncWork();

    mockNow.mockRestore();
  });

  it('Bug 2.1: foreground cold miss coalesces with running background refresh', async () => {
    const cache = new MemoryCacheAdapter<string>();
    const sf = new SingleFlight();
    const shield = new StampedeShield(cache, sf);
    let loaderCalls = 0;

    // Prime the cache
    await shield.getOrSet(
      'coalesce-key',
      async () => {
        loaderCalls += 1;
        return 'v1';
      },
      { ttlMs: 50, staleTtlMs: 100 },
    );
    expect(loaderCalls).toBe(1);

    // Wait for the entry to become fully expired (past both stale and hard TTL)
    await delay(200);

    // Now the background refresh and foreground cold-miss share SingleFlight key
    // so there should still be only 1 loader call
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        shield.getOrSet(
          'coalesce-key',
          async () => {
            loaderCalls += 1;
            await delay(20);
            return 'v2';
          },
          { ttlMs: 50, staleTtlMs: 100 },
        ),
      ),
    );

    expect(loaderCalls).toBe(2); // 1 initial + 1 foreground cold miss (coalesced)
    expect(results.every((r) => r === 'v2')).toBe(true);
  });

  // =========================================================================
  // Bug 2.2 — XFetch NaN Traps
  // =========================================================================

  it('Bug 2.2: Math.random()===0 does not produce NaN in XFetch', async () => {
    const cache = new MemoryCacheAdapter<string>();
    const shield = new StampedeShield(cache, new SingleFlight());

    await shield.getOrSet('nan-key', async () => 'v1', {
      ttlMs: 10_000,
      staleTtlMs: 10_000,
      beta: 1,
    });

    const envelope = cache.get('nan-key');
    expect(envelope).toBeDefined();

    // Mock Math.random to return exactly 0 — the NaN trigger
    vi.spyOn(Math, 'random').mockReturnValue(0);
    // Time still within soft expiry
    vi.spyOn(Date, 'now').mockReturnValue(envelope!.expiry - 1);

    // This should NOT throw or return NaN — should return cached value
    const result = await shield.getOrSet('nan-key', async () => 'v2', {
      ttlMs: 10_000,
      staleTtlMs: 10_000,
      beta: 1,
    });

    expect(result).toBe('v1');
  });

  it('Bug 2.2: sub-millisecond loader deltaMs is clamped to >= 1', async () => {
    const cache = new MemoryCacheAdapter<string>();
    const shield = new StampedeShield(cache, new SingleFlight());

    // A near-instant loader that completes in < 1ms
    await shield.getOrSet('fast-key', async () => 'instant', {
      ttlMs: 10_000,
      staleTtlMs: 10_000,
      beta: 1,
    });

    const envelope = cache.get('fast-key');
    expect(envelope).toBeDefined();
    // deltaMs must be at least 1 (clamped)
    expect(envelope!.deltaMs).toBeGreaterThanOrEqual(1);
  });

  it('Bug 2.2: XFetch with beta=0 never triggers early refresh', async () => {
    const cache = new MemoryCacheAdapter<string>();
    const shield = new StampedeShield(cache, new SingleFlight());
    let loaderCalls = 0;

    await shield.getOrSet(
      'beta0-key',
      async () => {
        loaderCalls += 1;
        return 'v1';
      },
      { ttlMs: 10_000, staleTtlMs: 10_000, beta: 0 },
    );

    const envelope = cache.get('beta0-key');
    vi.spyOn(Date, 'now').mockReturnValue(envelope!.expiry - 1);
    vi.spyOn(Math, 'random').mockReturnValue(Number.EPSILON);

    // With beta=0, the XFetch jitter term becomes 0, so no early refresh
    await shield.getOrSet(
      'beta0-key',
      async () => {
        loaderCalls += 1;
        return 'v2';
      },
      { ttlMs: 10_000, staleTtlMs: 10_000, beta: 0 },
    );

    expect(loaderCalls).toBe(1);
  });

  // =========================================================================
  // Bug 2.3 — Redis Hard-TTL (pxMs = ttlMs + staleTtlMs)
  // =========================================================================

  it('Bug 2.3: cache.set() receives pxMs = ttlMs + staleTtlMs', async () => {
    const mockCache = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const shield = new StampedeShield(mockCache, new SingleFlight());

    await shield.getOrSet('redis-key', async () => 'value', {
      ttlMs: 30_000,
      staleTtlMs: 120_000,
    });

    // pxMs (3rd arg) must be 30_000 + 120_000 = 150_000
    expect(mockCache.set).toHaveBeenCalledOnce();
    const [, , pxMs] = mockCache.set.mock.calls[0];
    expect(pxMs).toBe(150_000);
  });

  it('Bug 2.3: ShieldEnvelope stores all 4 fields (value, deltaMs, expiry, staleExpiry)', async () => {
    const mockCache = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const shield = new StampedeShield(mockCache, new SingleFlight());

    await shield.getOrSet('fields-key', async () => ({ data: 42 }), {
      ttlMs: 30_000,
      staleTtlMs: 120_000,
    });

    const [, envelope] = mockCache.set.mock.calls[0];
    expect(envelope).toHaveProperty('value');
    expect(envelope).toHaveProperty('deltaMs');
    expect(envelope).toHaveProperty('expiry');
    expect(envelope).toHaveProperty('staleExpiry');
    expect(envelope.value).toEqual({ data: 42 });
    expect(envelope.deltaMs).toBeGreaterThanOrEqual(1);
    expect(envelope.staleExpiry).toBe(envelope.expiry + 120_000);
  });

  // =========================================================================
  // Bug 2.4 — Unhandled Rejections & MemoryCacheAdapter
  // =========================================================================

  it('Bug 2.4: no unhandled rejection when onBackgroundError is omitted', async () => {
    const cache = new MemoryCacheAdapter<string>();
    const shield = new StampedeShield(cache, new SingleFlight());

    // Track unhandled rejections
    const unhandled: unknown[] = [];
    const handler = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', handler);

    // Prime cache
    await shield.getOrSet('no-handler-key', async () => 'v1', {
      ttlMs: 100,
      staleTtlMs: 5_000,
    });

    const envelope = cache.get('no-handler-key');
    vi.spyOn(Date, 'now').mockReturnValue(envelope!.expiry + 1);

    // Stale read with a failing loader, NO onBackgroundError
    const result = await shield.getOrSet(
      'no-handler-key',
      async () => { throw new Error('bg fail'); },
      { ttlMs: 100, staleTtlMs: 5_000 },
    );

    expect(result).toBe('v1');
    await flushAsyncWork();
    await delay(50);

    // No unhandled rejection should have fired
    expect(unhandled).toHaveLength(0);

    process.off('unhandledRejection', handler);
  });

  it('Bug 2.4: no unhandled rejection when onBackgroundError itself throws', async () => {
    const cache = new MemoryCacheAdapter<string>();
    const shield = new StampedeShield(cache, new SingleFlight());

    const unhandled: unknown[] = [];
    const handler = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', handler);

    await shield.getOrSet('throw-handler-key', async () => 'v1', {
      ttlMs: 100,
      staleTtlMs: 5_000,
    });

    const envelope = cache.get('throw-handler-key');
    vi.spyOn(Date, 'now').mockReturnValue(envelope!.expiry + 1);

    const result = await shield.getOrSet(
      'throw-handler-key',
      async () => { throw new Error('loader fail'); },
      {
        ttlMs: 100,
        staleTtlMs: 5_000,
        onBackgroundError: () => { throw new Error('handler also fails'); },
      },
    );

    expect(result).toBe('v1');
    await flushAsyncWork();
    await delay(50);

    expect(unhandled).toHaveLength(0);

    process.off('unhandledRejection', handler);
  });

  it('Bug 2.4: LRU hot keys survive eviction when accessed', () => {
    const cache = new MemoryCacheAdapter<string>(3);
    const mkEnv = (v: string) => ({
      value: v,
      deltaMs: 1,
      expiry: Date.now() + 10_000,
      staleExpiry: Date.now() + 20_000,
    });

    cache.set('a', mkEnv('a'), 10_000);
    cache.set('b', mkEnv('b'), 10_000);
    cache.set('c', mkEnv('c'), 10_000);

    // Touch 'a' to make it recently used
    expect(cache.get('a')?.value).toBe('a');

    // Insert 'd' — should evict 'b' (oldest untouched), not 'a'
    cache.set('d', mkEnv('d'), 10_000);

    expect(cache.get('a')?.value).toBe('a');  // survived — was recently used
    expect(cache.get('b')).toBeUndefined();    // evicted — was oldest
    expect(cache.get('c')?.value).toBe('c');   // survived
    expect(cache.get('d')?.value).toBe('d');   // just inserted
  });

  it('Bug 2.4: MemoryCacheAdapter evicts expired entries on .size access', async () => {
    const cache = new MemoryCacheAdapter<string>(10);
    const mkEnv = (v: string) => ({
      value: v,
      deltaMs: 1,
      expiry: Date.now() + 50,
      staleExpiry: Date.now() + 100,
    });

    cache.set('exp-a', mkEnv('a'), 50);
    cache.set('exp-b', mkEnv('b'), 50);
    expect(cache.size).toBe(2);

    // Wait for hard TTL to expire
    await delay(100);

    expect(cache.size).toBe(0);
    expect(cache.get('exp-a')).toBeUndefined();
    expect(cache.get('exp-b')).toBeUndefined();
  });
});
