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
