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
});
