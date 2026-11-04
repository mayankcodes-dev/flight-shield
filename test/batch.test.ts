import { afterEach, describe, expect, it, vi } from 'vitest';
import { BatchFlight } from '../src/index.js';

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BatchFlight', () => {
  it('flushes calls at the end of the time window', async () => {
    vi.useFakeTimers();
    const batches: number[][] = [];
    const batch = new BatchFlight<number, string>(
      async (keys) => {
        batches.push([...keys]);
        return keys.map((key) => `value:${key}`);
      },
      { maxWindowMs: 15 },
    );

    const pending: Array<Promise<string>> = [];
    for (let key = 0; key < 10; key += 1) {
      pending.push(batch.load(key));
      await vi.advanceTimersByTimeAsync(1);
    }

    expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(6);
    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: 10 }, (_, key) => `value:${key}`),
    );
    expect(batches).toEqual([Array.from({ length: 10 }, (_, key) => key)]);
  });

  it('flushes full batches immediately and leaves the remainder for the timer', async () => {
    const batches: number[][] = [];
    const batch = new BatchFlight<number, string>(
      async (keys) => {
        batches.push([...keys]);
        return keys.map((key) => `value:${key}`);
      },
      { maxBatchSize: 5, maxWindowMs: 20 },
    );

    const pending = Array.from({ length: 12 }, (_, key) => batch.load(key));
    await flushMicrotasks();
    expect(batches.map((keys) => keys.length)).toEqual([5, 5]);

    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: 12 }, (_, key) => `value:${key}`),
    );
    expect(batches.map((keys) => keys.length)).toEqual([5, 5, 2]);
  });

  it('deduplicates keys and demultiplexes individual errors', async () => {
    const batches: number[][] = [];
    const notFound = new Error('Not Found');
    const batch = new BatchFlight<number, string>(
      async (keys) => {
        batches.push([...keys]);
        return keys.map((key) => (key === 2 ? notFound : `value:${key}`));
      },
      { maxWindowMs: 5 },
    );

    const results = await batch.loadMany([1, 2, 3, 2]);

    expect(batches).toEqual([[1, 2, 3]]);
    expect(results[0]).toBe('value:1');
    expect(results[1]).toBeInstanceOf(Error);
    expect((results[1] as Error).message).toBe('Not Found');
    expect(results[2]).toBe('value:3');
    expect(results[3]).toBeInstanceOf(Error);
    await expect(batch.load(2)).rejects.toBe(notFound);
  });

  it('rejects every key when an array response is misaligned', async () => {
    const batch = new BatchFlight<number, string>(
      async () => ['only-one'],
      { maxWindowMs: 1 },
    );

    const results = await Promise.allSettled([batch.load(1), batch.load(2)]);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(results[0]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringContaining('expected one result per key') }),
    });
  });

  it('supports Map responses and preserves per-key errors', async () => {
    const batch = new BatchFlight<number, string>(
      async (keys) => new Map(keys.map((key) => [key, key === 2 ? new Error('Not Found') : `value:${key}`])),
      { maxWindowMs: 5 },
    );

    const results = await batch.loadMany([1, 2, 3]);

    expect(results[0]).toBe('value:1');
    expect((results[1] as Error).message).toBe('Not Found');
    expect(results[2]).toBe('value:3');
  });
});
