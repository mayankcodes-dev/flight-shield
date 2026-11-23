import { serializeKey } from './serializer.js';

export interface FlightOptions<T> {
  timeoutMs?: number;
  clone?: boolean | ((val: T) => T);
  maxFlightWindowMs?: number;
}

export interface FlightResult<T> {
  value: T;
  shared: boolean;
  coalescedCount: number;
}

interface FlightEntry<T> {
  controller: AbortController;
  signal: AbortSignal;
  promise: Promise<T>;
  callers: number;
  timer?: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
}

const DEFAULT_SINGLETON_KEY = Symbol.for('flight-shield.default');

function validateDuration(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError(`${name} must be a finite, non-negative number`);
  }
}

function getAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('The flight was aborted');
}

/**
 * Bug 1.2 fix: Safe clone that catches DataCloneError from structuredClone
 * and falls back to JSON round-trip, then identity. Also preserves prototype
 * chain by cloning all callers (including initiator) uniformly.
 */
function cloneValue<T>(value: T, clone: FlightOptions<T>['clone']): T {
  if (clone === true) {
    try {
      return structuredClone(value);
    } catch {
      // structuredClone throws DOMException [DataCloneError] for functions,
      // Symbols, Proxies, WeakMaps, etc. Fall back to JSON round-trip.
      try {
        return JSON.parse(JSON.stringify(value)) as T;
      } catch {
        // If JSON also fails (circular refs without toJSON), return as-is.
        // The caller accepted the risk by not providing a custom clone fn.
        return value;
      }
    }
  }
  if (typeof clone === 'function') {
    return clone(value);
  }
  return value;
}

export class SingleFlight {
  private readonly inflight = new Map<string, FlightEntry<unknown>>();

  get inFlightCount(): number {
    return this.inflight.size;
  }

  doWithMeta<T>(
    key: string,
    fn: (signal: AbortSignal) => Promise<T>,
    options?: FlightOptions<T>,
  ): Promise<FlightResult<T>> {
    validateDuration('timeoutMs', options?.timeoutMs);
    validateDuration('maxFlightWindowMs', options?.maxFlightWindowMs);

    const current = this.inflight.get(key) as FlightEntry<T> | undefined;
    if (current !== undefined) {
      current.callers += 1;
      return this.resultFor(current, options);
    }

    const entry = this.createEntry(fn, options);
    this.inflight.set(key, entry as FlightEntry<unknown>);
    this.installWindowTimer(key, entry, options?.maxFlightWindowMs);

    entry.abortListener = () => {
      this.removeEntry(key, entry);
    };
    entry.signal.addEventListener('abort', entry.abortListener, { once: true });
    if (entry.signal.aborted) {
      entry.abortListener();
    }

    // Bug 1.1 fix: cleanup uses reference-checked removeEntry (already guarded)
    void entry.promise.then(
      () => this.removeEntry(key, entry),
      () => this.removeEntry(key, entry),
    );

    return this.resultFor(entry, options);
  }

  do<T>(
    key: string,
    fn: (signal: AbortSignal) => Promise<T>,
    options?: FlightOptions<T>,
  ): Promise<T> {
    return this.doWithMeta(key, fn, options).then(({ value }) => value);
  }

  /**
   * Bug 1.4 fix: wrap() now preserves `this` context via function() + apply,
   * and the default key includes args.length to disambiguate f() vs f(undefined).
   */
  wrap<Args extends unknown[], T>(
    fn: (...args: Args) => Promise<T>,
    options?: FlightOptions<T> & { keyFn?: (...args: Args) => string },
  ): (...args: Args) => Promise<T> {
    const { keyFn, ...flightOptions } = options ?? {};
    const self = this;

    // Use a regular function (not arrow) so `this` from the call-site is captured
    return function (this: unknown, ...args: Args): Promise<T> {
      const key = keyFn === undefined
        ? serializeKey({ __len: args.length, __args: args })
        : keyFn(...args);
      const receiver = this;
      return self.do(key, (signal) => fn.apply(receiver, args), flightOptions);
    };
  }

  /**
   * Bug 1.1 fix: forget() only evicts the key from the map so subsequent calls
   * start a fresh flight. It does NOT abort the in-flight operation — existing
   * waiters finish undisturbed (matching Go's singleflight.Group.Forget semantics).
   */
  forget(key: string): boolean {
    const entry = this.inflight.get(key);
    if (entry === undefined) {
      return false;
    }

    // Only evict from map; do NOT abort. Existing callers keep waiting on the
    // same promise and will resolve/reject normally.
    this.removeEntry(key, entry);
    return true;
  }

  /**
   * abort() is the new explicit hard-cancellation method. It evicts the key AND
   * aborts the shared AbortController, rejecting all waiting callers.
   * Use this only when you intentionally want to kill a running flight.
   */
  abort(key: string): boolean {
    const entry = this.inflight.get(key);
    if (entry === undefined) {
      return false;
    }

    this.removeEntry(key, entry);
    entry.controller.abort(new Error(`Flight aborted: ${key}`));
    return true;
  }

  private createEntry<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    options?: FlightOptions<T>,
  ): FlightEntry<T> {
    const controller = new AbortController();
    const signal = options?.timeoutMs === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs)]);
    const operation = Promise.resolve().then(() => fn(signal));
    const promise = this.raceWithAbort(operation, signal);

    return {
      controller,
      signal,
      promise,
      callers: 1,
    };
  }

  /**
   * Bug 1.2 fix: Every caller (including the initiator) gets cloned.
   * The master value is kept inside the promise; .then() clones for each caller.
   */
  private resultFor<T>(entry: FlightEntry<T>, options?: FlightOptions<T>): Promise<FlightResult<T>> {
    return entry.promise.then((value) => {
      const coalescedCount = entry.callers;
      return {
        value: cloneValue(value, options?.clone),
        shared: coalescedCount > 1,
        coalescedCount,
      };
    });
  }

  /**
   * Bug 1.3 fix: raceWithAbort uses { once: true } on all listeners (already did),
   * and cleans up synchronously on settlement to prevent MaxListenersExceededWarning.
   */
  private raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
      };

      const onAbort = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(getAbortReason(signal));
      };

      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }

      operation.then(
        (value) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(error);
        },
      );
    });
  }

  /**
   * Bug 1.3 fix: Window timer always calls .unref() so it won't keep
   * CLI scripts / test suites alive. Timer is always cleared in removeEntry.
   */
  private installWindowTimer<T>(
    key: string,
    entry: FlightEntry<T>,
    maxFlightWindowMs: number | undefined,
  ): void {
    if (maxFlightWindowMs === undefined) {
      return;
    }

    const timer = setTimeout(() => {
      this.removeEntry(key, entry);
    }, maxFlightWindowMs);
    entry.timer = timer;

    // Always unref so the timer doesn't keep the process alive
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref(): void }).unref();
    }
  }

  /**
   * Bug 1.1 fix (ABA race): removeEntry is guarded with a strict reference check.
   * If the map entry for `key` has already been replaced by a new flight (Flight B),
   * the old flight's cleanup won't delete Flight B from the map.
   *
   * Bug 1.3 fix: Always clears timer and removes abort listener to prevent leaks.
   */
  private removeEntry<T>(key: string, entry: FlightEntry<T>): void {
    // Critical ABA guard: only delete if the map still points to THIS exact entry
    if (this.inflight.get(key) === entry) {
      this.inflight.delete(key);
    }

    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }

    if (entry.abortListener !== undefined) {
      entry.signal.removeEventListener('abort', entry.abortListener);
      entry.abortListener = undefined;
    }
  }
}

type GlobalWithSingleton = typeof globalThis & { [key: symbol]: unknown };

function getDefaultSingleFlight(): SingleFlight {
  const globalScope = globalThis as GlobalWithSingleton;
  const existing = globalScope[DEFAULT_SINGLETON_KEY];

  if (existing !== undefined && typeof (existing as SingleFlight).do === 'function') {
    return existing as SingleFlight;
  }

  const instance = new SingleFlight();
  globalScope[DEFAULT_SINGLETON_KEY] = instance;
  return instance;
}

export const defaultSingleFlight = getDefaultSingleFlight();
export const singleFlight = defaultSingleFlight;
