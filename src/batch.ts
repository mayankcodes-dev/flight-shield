import { serializeKey } from './serializer.js';

export interface BatchOptions<K> {
  maxBatchSize?: number;
  maxWindowMs?: number;
  keySerializer?: (key: K) => string;
  timeoutMs?: number;
}

type BatchValue<V> = V | Error;
type BatchResponse<K, V> =
  | ReadonlyArray<BatchValue<V>>
  | ReadonlyMap<K, BatchValue<V>>;
type BatchLoader<K, V> = (
  keys: readonly K[],
  signal: AbortSignal,
) => Promise<BatchResponse<K, V>>;

interface PendingKey<K, V> {
  key: K;
  serializedKey: string;
  promise: Promise<V>;
  resolve: (value: V) => void;
  reject: (reason?: unknown) => void;
}

class BatchItemError {
  constructor(readonly error: Error) {}
}

const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_MAX_WINDOW_MS = 10;

function validateNonNegativeDuration(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError(`${name} must be a finite, non-negative number`);
  }
}

function validateBatchSize(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('maxBatchSize must be a positive safe integer');
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Batch operation aborted');
}

function isReadonlyMap<K, V>(value: unknown): value is ReadonlyMap<K, V> {
  if (value instanceof Map) {
    return true;
  }

  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<ReadonlyMap<K, V>>;
  return typeof candidate.entries === 'function' && typeof candidate.has === 'function';
}

export class BatchFlight<K, V> {
  private readonly batchFn: BatchLoader<K, V>;
  private readonly maxBatchSize: number;
  private readonly maxWindowMs: number;
  private readonly timeoutMs?: number;
  private readonly keySerializer: (key: K) => string;
  private readonly pending = new Map<string, PendingKey<K, V>>();
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(batchFn: BatchLoader<K, V>, options: BatchOptions<K> = {}) {
    this.batchFn = batchFn;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.maxWindowMs = options.maxWindowMs ?? DEFAULT_MAX_WINDOW_MS;
    this.timeoutMs = options.timeoutMs;
    this.keySerializer = options.keySerializer ?? ((key) => serializeKey(key));

    validateBatchSize(this.maxBatchSize);
    validateNonNegativeDuration('maxWindowMs', this.maxWindowMs);
    validateNonNegativeDuration('timeoutMs', this.timeoutMs);
  }

  load(key: K): Promise<V> {
    try {
      const entry = this.enqueue(key);
      return entry.promise.catch((error: unknown) => {
        if (error instanceof BatchItemError) {
          throw error.error;
        }
        throw error;
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async loadMany(keys: readonly K[]): Promise<Array<V | Error>> {
    const entries = keys.map((key) => this.enqueue(key));
    return Promise.all(
      entries.map((entry) =>
        entry.promise.then(
          (value) => value,
          (error: unknown) => {
            if (error instanceof BatchItemError) {
              return error.error;
            }
            throw error;
          },
        ),
      ),
    );
  }

  private enqueue(key: K): PendingKey<K, V> {
    const serializedKey = this.keySerializer(key);
    const existing = this.pending.get(serializedKey);
    if (existing !== undefined) {
      return existing;
    }

    let resolve!: (value: V) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<V>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry: PendingKey<K, V> = {
      key,
      serializedKey,
      promise,
      resolve,
      reject,
    };

    this.pending.set(serializedKey, entry);
    if (this.pending.size >= this.maxBatchSize) {
      this.flush();
    } else {
      this.scheduleFlush();
    }

    return entry;
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.maxWindowMs);
  }

  private flush(): void {
    if (this.pending.size === 0) {
      return;
    }

    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    const entries = Array.from(this.pending.values());
    this.pending.clear();
    const keys = entries.map(({ key }) => key);

    void this.executeBatch(entries, keys);
  }

  private async executeBatch(
    entries: readonly PendingKey<K, V>[],
    keys: readonly K[],
  ): Promise<void> {
    try {
      const response = await this.invokeBatch(keys);
      this.resolveBatch(entries, keys, response);
    } catch (error) {
      for (const entry of entries) {
        entry.reject(error);
      }
    }
  }

  private resolveBatch(
    entries: readonly PendingKey<K, V>[],
    keys: readonly K[],
    response: BatchResponse<K, V>,
  ): void {
    if (Array.isArray(response)) {
      if (response.length !== keys.length) {
        throw new Error(
          `Batch loader returned ${response.length} results for ${keys.length} keys; expected one result per key`,
        );
      }

      entries.forEach((entry, index) => {
        this.resolveEntry(entry, response[index]);
      });
      return;
    }

    if (isReadonlyMap<K, V>(response)) {
      const serializedResults = new Map<string, BatchValue<V>>();
      try {
        for (const [key, value] of response.entries()) {
          serializedResults.set(this.keySerializer(key), value);
        }
      } catch (error) {
        throw new Error(`Batch loader returned a map with an unserializable key: ${String(error)}`);
      }

      for (const entry of entries) {
        if (!serializedResults.has(entry.serializedKey)) {
          entry.reject(new Error(`Batch loader did not return a value for key ${entry.serializedKey}`));
          continue;
        }
        this.resolveEntry(entry, serializedResults.get(entry.serializedKey)!);
      }
      return;
    }

    throw new Error('Batch loader must return an array or Map');
  }

  private resolveEntry(entry: PendingKey<K, V>, value: BatchValue<V>): void {
    if (value instanceof Error) {
      entry.reject(new BatchItemError(value));
      return;
    }
    entry.resolve(value);
  }

  private invokeBatch(keys: readonly K[]): Promise<BatchResponse<K, V>> {
    const controller = new AbortController();
    const signal = this.timeoutMs === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs)]);
    const operation = Promise.resolve().then(() => this.batchFn(keys, signal));

    return this.raceWithAbort(operation, signal);
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
        reject(abortReason(signal));
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
}
