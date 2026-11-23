import { describe, expect, it } from 'vitest';
import { serializeKey } from '../src/serializer.js';
import { SingleFlight } from '../src/singleflight.js';

describe('SingleFlight', () => {
  it('coalesces concurrent calls and reports shared metadata', async () => {
    const singleFlight = new SingleFlight();
    let executions = 0;

    const calls = Array.from({ length: 100 }, () =>
      singleFlight.doWithMeta('user:1', async () => {
        executions += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { userId: 'user:1' };
      }),
    );

    const results = await Promise.all(calls);

    expect(executions).toBe(1);
    expect(results.every((result) => result.shared)).toBe(true);
    expect(results.every((result) => result.coalescedCount === 100)).toBe(true);
    expect(results.every((result) => result.value.userId === 'user:1')).toBe(true);
  });

  it('propagates rejections, evicts the key, and permits a fresh call', async () => {
    const singleFlight = new SingleFlight();
    const failure = new Error('upstream failed');
    let shouldFail = true;

    const fn = async (): Promise<string> => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (shouldFail) {
        throw failure;
      }
      return 'recovered';
    };

    const waitingCalls = await Promise.allSettled([
      singleFlight.do('failure', fn),
      singleFlight.do('failure', fn),
      singleFlight.do('failure', fn),
    ]);

    expect(waitingCalls.every((result) => result.status === 'rejected' && result.reason === failure)).toBe(true);
    expect(singleFlight.inFlightCount).toBe(0);

    shouldFail = false;
    await expect(singleFlight.do('failure', fn)).resolves.toBe('recovered');
  });

  it('aborts timed out work and frees the key', async () => {
    const singleFlight = new SingleFlight();
    let aborted = false;

    const pending = singleFlight.do(
      'hung',
      async (signal) => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise<string>(() => {});
      },
      { timeoutMs: 50 },
    );

    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(aborted).toBe(true);
    expect(singleFlight.inFlightCount).toBe(0);
  });

  it('isolates references when clone is enabled', async () => {
    const singleFlight = new SingleFlight();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const fn = async () => {
      await gate;
      return { nested: { value: 1 } };
    };

    const first = singleFlight.do('clone', fn, { clone: true });
    const second = singleFlight.do('clone', fn, { clone: true });
    release();

    const [firstValue, secondValue] = await Promise.all([first, second]);
    firstValue.nested.value = 99;

    expect(secondValue.nested.value).toBe(1);
  });

  // =========================================================================
  // Bug 1.1: forget() should NOT abort shared waiters
  // =========================================================================
  it('forget() evicts the key but lets existing callers finish (no abort)', async () => {
    const singleFlight = new SingleFlight();
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });

    // Start flight with 3 callers
    const caller1 = singleFlight.do('key-a', async () => gate);
    const caller2 = singleFlight.do('key-a', async () => gate);
    const caller3 = singleFlight.do('key-a', async () => gate);

    expect(singleFlight.inFlightCount).toBe(1);

    // forget() evicts from map, but does NOT abort the flight
    const forgotten = singleFlight.forget('key-a');
    expect(forgotten).toBe(true);
    expect(singleFlight.inFlightCount).toBe(0);

    // Existing callers should still resolve when the loader finishes
    release('done');
    const results = await Promise.all([caller1, caller2, caller3]);
    expect(results).toEqual(['done', 'done', 'done']);
  });

  // =========================================================================
  // Bug 1.1: forget() ABA race — new flight should not be deleted by old cleanup
  // =========================================================================
  it('forget() does not create an ABA race with subsequent flights', async () => {
    const singleFlight = new SingleFlight();
    let releaseA!: (value: string) => void;
    let releaseB!: (value: string) => void;
    const gateA = new Promise<string>((resolve) => { releaseA = resolve; });
    const gateB = new Promise<string>((resolve) => { releaseB = resolve; });

    // Flight A starts
    const flightA = singleFlight.do('shared-key', async () => gateA);

    // forget() evicts flight A from the map
    singleFlight.forget('shared-key');

    // Flight B starts immediately on the same key
    const flightB = singleFlight.do('shared-key', async () => gateB);
    expect(singleFlight.inFlightCount).toBe(1);

    // Resolve Flight A — its cleanup must NOT delete Flight B from the map
    releaseA('result-a');
    await flightA;

    // Flight B should still be in the map
    expect(singleFlight.inFlightCount).toBe(1);

    releaseB('result-b');
    await expect(flightB).resolves.toBe('result-b');
    expect(singleFlight.inFlightCount).toBe(0);
  });

  // =========================================================================
  // Bug 1.1: abort() SHOULD hard-cancel all waiters (the new explicit method)
  // =========================================================================
  it('abort() hard-cancels a flight and rejects all waiters', async () => {
    const singleFlight = new SingleFlight();

    const caller1 = singleFlight.do('abort-me', async () => {
      return new Promise<string>(() => {}); // never resolves
    });
    const caller2 = singleFlight.do('abort-me', async () => {
      return new Promise<string>(() => {});
    });

    singleFlight.abort('abort-me');

    const results = await Promise.allSettled([caller1, caller2]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(singleFlight.inFlightCount).toBe(0);
  });

  // =========================================================================
  // Bug 1.2: clone: true should not crash on non-cloneable values
  // =========================================================================
  it('clone: true gracefully handles non-cloneable values (functions, symbols)', async () => {
    const singleFlight = new SingleFlight();

    const result = await singleFlight.do(
      'fn-value',
      async () => ({
        name: 'test',
        helper: () => 42,       // functions break structuredClone
        sym: Symbol('private'), // symbols break structuredClone
      }),
      { clone: true },
    );

    // Should not throw — falls back to JSON (helper/sym will be stripped) or identity
    expect(result.name).toBe('test');
  });

  // =========================================================================
  // Bug 1.4: wrap() should preserve `this` context
  // =========================================================================
  it('wrap() preserves this receiver context for class methods', async () => {
    const singleFlight = new SingleFlight();

    class UserService {
      dbName = 'production';
      async getUser(id: string): Promise<string> {
        return `${this.dbName}:user:${id}`;
      }
    }

    const service = new UserService();
    service.getUser = singleFlight.wrap(service.getUser.bind(service), {
      keyFn: (id) => `user:${id}`,
    });

    await expect(service.getUser('42')).resolves.toBe('production:user:42');
  });

  // =========================================================================
  // Bug 1.4: wrap() should distinguish f() from f(undefined)
  // =========================================================================
  it('wrap() distinguishes zero-arg call from explicit undefined arg', async () => {
    const singleFlight = new SingleFlight();
    let callCount = 0;

    const fn = singleFlight.wrap(
      async (...args: unknown[]) => {
        callCount += 1;
        return args.length;
      },
    );

    const [zeroArgs, oneArg] = await Promise.all([
      fn(),
      fn(undefined),
    ]);

    // These must be different flights (different keys) because args differ
    expect(zeroArgs).toBe(0);
    expect(oneArg).toBe(1);
    expect(callCount).toBe(2);
  });
});

describe('serializeKey', () => {
  it('serializes supported values deterministically', () => {
    expect(serializeKey({ a: 1, b: 2 })).toBe(serializeKey({ b: 2, a: 1 }));
    expect(serializeKey(123n)).toContain('123n');
    expect(serializeKey(new Map([['b', 2], ['a', 1]]))).toBe(
      serializeKey(new Map([['a', 1], ['b', 2]])),
    );
    expect(serializeKey(new Set(['b', 'a']))).toBe(serializeKey(new Set(['a', 'b'])));
  });

  it('handles circular objects without throwing', () => {
    const circular: { name: string; self?: unknown } = { name: 'circular' };
    circular.self = circular;

    expect(() => serializeKey(circular)).not.toThrow();
    expect(serializeKey(circular)).toContain('ref:0');
  });
});
