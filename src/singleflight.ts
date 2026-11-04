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

function cloneValue<T>(value: T, clone: FlightOptions<T>['clone']): T {
  if (clone === true) {
    return structuredClone(value);
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

  wrap<Args extends unknown[], T>(
    fn: (...args: Args) => Promise<T>,
    options?: FlightOptions<T> & { keyFn?: (...args: Args) => string },
  ): (...args: Args) => Promise<T> {
    const { keyFn, ...flightOptions } = options ?? {};

    return async (...args: Args): Promise<T> => {
      const key = keyFn === undefined ? serializeKey(args) : keyFn(...args);
      return this.do(key, (signal) => fn(...args), flightOptions);
    };
  }

  forget(key: string): boolean {
    const entry = this.inflight.get(key);
    if (entry === undefined) {
      return false;
    }

    this.removeEntry(key, entry);
    entry.controller.abort(new Error(`Flight forgotten: ${key}`));
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

    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref(): void }).unref();
    }
  }

  private removeEntry<T>(key: string, entry: FlightEntry<T>): void {
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
