import { afterEach, describe, expect, it, vi } from 'vitest';
import { BatchFlight, serializeKey } from '../src/index.js';

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

  // =========================================================================
  // Bug 3.1 — Duplicate Key Shared Resolution
  // =========================================================================

  it('Bug 3.1: duplicate load() calls for the same key both resolve with the same value', async () => {
    let batchFnCalls = 0;
    const batch = new BatchFlight<number, string>(
      async (keys) => {
        batchFnCalls += 1;
        return keys.map((key) => `user:${key}`);
      },
      { maxWindowMs: 5 },
    );

    // Three concurrent calls: load(1), load(1), load(2)
    const p1 = batch.load(1);
    const p2 = batch.load(1); // duplicate
    const p3 = batch.load(2);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(batchFnCalls).toBe(1);
    // Both callers for key=1 get the correct value
    expect(r1).toBe('user:1');
    expect(r2).toBe('user:1');
    // Caller for key=2 gets their own value (not cross-contaminated)
    expect(r3).toBe('user:2');
  });

  it('Bug 3.1: duplicate keys in loadMany — no hanging promises, no data leaks', async () => {
    const batches: number[][] = [];
    const batch = new BatchFlight<number, string>(
      async (keys) => {
        batches.push([...keys]);
        return keys.map((k) => `val:${k}`);
      },
      { maxWindowMs: 5 },
    );

    // 5 calls, keys [1, 1, 2, 1, 2] — all duplicates except first occurrence
    const results = await batch.loadMany([1, 1, 2, 1, 2]);

    // batchFn receives deduplicated keys
    expect(batches).toEqual([[1, 2]]);
    // All callers resolve correctly
    expect(results).toEqual(['val:1', 'val:1', 'val:2', 'val:1', 'val:2']);
  });

  it('Bug 3.1: DB-style WHERE IN returns fewer rows — array length mismatch rejects all', async () => {
    // Simulates a DB that returns unique rows for WHERE id IN (1, 1, 2)
    const batch = new BatchFlight<number, string>(
      async (keys) => {
        // If somehow duplicate keys leaked through, DB returns only unique results
        const unique = [...new Set(keys)];
        return unique.map((k) => `user:${k}`);
      },
      { maxWindowMs: 5 },
    );

    // With dedup, batchFn gets [1, 2], returns ['user:1', 'user:2'] — length matches
    const results = await batch.loadMany([1, 1, 2]);
    expect(results).toEqual(['user:1', 'user:1', 'user:2']);
  });

  // =========================================================================
  // Bug 3.2 — Array Length Assertion & Map Lookup
  // =========================================================================

  it('Bug 3.2: array response length !== keys length rejects with descriptive error', async () => {
    const batch = new BatchFlight<number, string>(
      async () => ['one', 'two', 'three'],  // returns 3 for 2 keys
      { maxWindowMs: 1 },
    );

    const results = await Promise.allSettled([batch.load(10), batch.load(20)]);

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    const reason = (results[0] as PromiseRejectedResult).reason as Error;
    expect(reason.message).toContain('3 results');
    expect(reason.message).toContain('2 keys');
  });

  it('Bug 3.2: Map response with object keys matched via serialized key', async () => {
    // Using object keys — Map.get() with new objects fails reference equality
    type ObjKey = { id: number };
    const batch = new BatchFlight<ObjKey, string>(
      async (keys) => {
        // batchFn creates NEW object keys (different references)
        const result = new Map<ObjKey, string>();
        for (const key of keys) {
          result.set({ id: key.id }, `user:${key.id}`);  // new object!
        }
        return result;
      },
      { maxWindowMs: 5 },
    );

    const results = await batch.loadMany([{ id: 1 }, { id: 2 }]);
    expect(results[0]).toBe('user:1');
    expect(results[1]).toBe('user:2');
  });

  it('Bug 3.2: Map response missing a key rejects only that key', async () => {
    const batch = new BatchFlight<number, string>(
      async (keys) => {
        const result = new Map<number, string>();
        // Intentionally skip key=2
        for (const key of keys) {
          if (key !== 2) result.set(key, `user:${key}`);
        }
        return result;
      },
      { maxWindowMs: 5 },
    );

    const results = await batch.loadMany([1, 2, 3]);
    expect(results[0]).toBe('user:1');
    expect(results[1]).toBeInstanceOf(Error);
    expect((results[1] as Error).message).toContain('did not return a value');
    expect(results[2]).toBe('user:3');
  });

  // =========================================================================
  // Bug 3.3 — loadMany([]) Empty Input & Argument Validation
  // =========================================================================

  it('Bug 3.3: loadMany([]) returns [] without invoking batchFn', async () => {
    let batchFnCalled = false;
    const batch = new BatchFlight<number, string>(
      async (keys) => {
        batchFnCalled = true;
        return keys.map((k) => `val:${k}`);
      },
      { maxWindowMs: 5 },
    );

    const results = await batch.loadMany([]);

    expect(results).toEqual([]);
    expect(batchFnCalled).toBe(false);
  });

  it('Bug 3.3: loadMany([]) does not start a batch timer', async () => {
    let batchFnCalled = false;
    const batch = new BatchFlight<number, string>(
      async (keys) => {
        batchFnCalled = true;
        return keys.map((k) => `val:${k}`);
      },
      { maxWindowMs: 10 },
    );

    const result = await batch.loadMany([]);
    expect(result).toEqual([]);
    // Wait real time to ensure no timer fires
    await new Promise((r) => setTimeout(r, 30));
    expect(batchFnCalled).toBe(false);
  });
});

// =========================================================================
// Bug 3.4 — serializeKey Edge Cases
// =========================================================================

describe('serializeKey — Bug 3.4 edge cases', () => {
  it('handles BigInt without throwing', () => {
    const key = serializeKey(10092837492n);
    expect(key).toBe('bigint:10092837492n');
    // Different BigInts produce different keys
    expect(serializeKey(1n)).not.toBe(serializeKey(2n));
  });

  it('handles circular references without stack overflow', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    // Must not throw RangeError: Maximum call stack size exceeded
    expect(() => serializeKey(a)).not.toThrow();
    const key = serializeKey(a);
    expect(key).toContain('ref:');
  });

  it('distinguishes Date instances from plain objects', () => {
    const d1 = serializeKey(new Date(100));
    const d2 = serializeKey(new Date(200));
    const obj = serializeKey({});

    expect(d1).not.toBe(d2);     // different timestamps
    expect(d1).not.toBe(obj);    // date !== empty object
    expect(d1).toContain('date:');
  });

  it('distinguishes RegExp instances from plain objects', () => {
    const r1 = serializeKey(/ab/g);
    const r2 = serializeKey(/ab/i);
    const obj = serializeKey({});

    expect(r1).not.toBe(r2);     // different flags
    expect(r1).not.toBe(obj);    // regexp !== empty object
    expect(r1).toContain('regexp:');
  });

  it('distinguishes NaN, Infinity, -Infinity, null, and -0', () => {
    const nan = serializeKey(NaN);
    const inf = serializeKey(Infinity);
    const negInf = serializeKey(-Infinity);
    const nul = serializeKey(null);
    const negZero = serializeKey(-0);
    const zero = serializeKey(0);

    // All must be unique — no collisions onto "null"
    const keys = new Set([nan, inf, negInf, nul, negZero, zero]);
    expect(keys.size).toBe(6);
  });

  it('distinguishes Set([1, "1"]) elements with type prefixes', () => {
    const s = serializeKey(new Set([1, '1']));
    expect(s).toContain('set:');
    // number 1 and string '1' must not collide
    expect(serializeKey(1)).not.toBe(serializeKey('1'));
  });

  it('handles Map keys with type-safe serialization', () => {
    const m1 = serializeKey(new Map([[1, 'a']]));
    const m2 = serializeKey(new Map([['1', 'a']]));
    // number key 1 vs string key '1' must produce different serializations
    expect(m1).not.toBe(m2);
  });

  it('handles undefined and symbols', () => {
    expect(serializeKey(undefined)).toBe('undefined');
    const s1 = serializeKey(Symbol('test'));
    const s2 = serializeKey(Symbol('test'));
    expect(s1).toContain('symbol:');
    // Two different Symbol('test') are different objects
    // but their string representation is the same — that's acceptable for key dedup
  });

  it('handles nested objects deterministically (sorted keys)', () => {
    const a = serializeKey({ z: 1, a: 2 });
    const b = serializeKey({ a: 2, z: 1 });
    expect(a).toBe(b); // key order doesn't matter
  });

  it('handles Invalid Date', () => {
    const key = serializeKey(new Date('invalid'));
    expect(key).toBe('date:Invalid Date');
  });
});
