<p align="center">
  <img src="./assets/flight-shield-logo.svg" alt="flight-shield logo" width="144" />
</p>

<h1 align="center">flight-shield</h1>

<p align="center">Keep duplicate work away from your database, APIs, and caches.</p>

<p align="center">
  Zero runtime dependencies · Node.js 20+ · ESM + CommonJS · MIT
</p>

`flight-shield` is a small TypeScript toolkit for one common backend problem: many requests ask for the same data at the same time.

## The three tools

| Tool | Use it when | Result |
| --- | --- | --- |
| `SingleFlight` | Several callers need the same key now | One upstream operation, many waiters |
| `StampedeShield` | A cached value needs safe refresh | Fresh, stale, and background refresh states |
| `BatchFlight` | Your upstream accepts many keys at once | A short window of keys becomes one batch |

Without coordination, 100 requests can create 100 database calls. That is a **thundering herd**. When an item expires and every request refills it independently, it is a **cache stampede**.

## Install

```bash
npm install flight-shield
```

```ts
import { singleFlight } from 'flight-shield';
```

```js
const { singleFlight } = require('flight-shield');
```

The default `singleFlight` instance is shared by ESM and CommonJS imports in the same process through `Symbol.for('flight-shield.default')`.

## 1. SingleFlight

Use a stable key. Concurrent calls with that key share one promise.

```ts
import { singleFlight } from 'flight-shield';

const user = await singleFlight.do(
  `user:${userId}`,
  (signal) => fetch(`https://users.internal/${userId}`, { signal }).then((response) => {
    if (!response.ok) throw new Error(`User service returned ${response.status}`);
    return response.json() as Promise<{ id: string; name: string }>;
  }),
  { timeoutMs: 2_000, clone: true },
);
```

`clone: true` gives each caller a separate `structuredClone`. This prevents one request from mutating the object seen by another request.

For function wrappers, `wrap` uses `serializeKey(args)` by default:

```ts
const getUser = singleFlight.wrap(
  async (tenantId: string, id: string) => loadUser(tenantId, id),
  { keyFn: (tenantId, id) => `${tenantId}:user:${id}`, clone: true },
);
```

## 2. StampedeShield (v2.0)

`StampedeShield` adds cache behavior around a loader:

1. **Fresh value:** return it immediately.
2. **XFetch refresh:** sometimes refresh a fresh value early, without making the caller wait.
3. **Stale-while-revalidate:** after `ttlMs`, serve the old value while one refresh runs.
4. **Hard miss:** use `SingleFlight`, so concurrent cold misses call the loader once.

```ts
import { MemoryCacheAdapter, StampedeShield } from 'flight-shield';

type Product = { id: string; price: number };
const shield = new StampedeShield<Product>(new MemoryCacheAdapter(10_000));

const product = await shield.getOrSet(
  'product:42',
  (signal) => fetchProduct('42', signal),
  {
    ttlMs: 30_000,
    staleTtlMs: 120_000,
    beta: 1,
    timeoutMs: 2_000,
    clone: true,
    onBackgroundError: (error, key) => logger.warn({ error, key }),
  },
);
```

`MemoryCacheAdapter` is bounded and LRU. For Redis or another shared cache, implement the small `CacheAdapter<T>` interface. The shield itself is process-local; use a distributed lock when refreshes must coordinate across pods.

## 3. BatchFlight (v3.0)

`BatchFlight` collects keys for a short window and sends unique keys to a batch endpoint. It flushes when the window ends or the batch reaches `maxBatchSize`.

```ts
import { BatchFlight } from 'flight-shield';

type User = { id: number; name: string };

const users = new BatchFlight<number, User>(
  async (ids, signal) => {
    const response = await fetch('https://users.internal/batch', {
      method: 'POST',
      body: JSON.stringify({ ids }),
      signal,
    });
    return (await response.json()) as User[];
  },
  { maxBatchSize: 50, maxWindowMs: 10, timeoutMs: 1_000 },
);

const [one, two] = await Promise.all([users.load(1), users.load(2)]);
```

The batch loader can return:

- an array in the exact order of the unique input keys; or
- a `ReadonlyMap` keyed by the input keys.

An array length mismatch rejects every call in that batch. An `Error` result rejects only that key. `loadMany` keeps item errors in their original positions:

```ts
const results = await users.loadMany([1, 2, 3]);
// [User, Error, User]
```

## Backend examples

### Express

```ts
app.get('/users/:id', async (request, response, next) => {
  try {
    const user = await singleFlight.do(
      `user:${request.params.id}`,
      (signal) => fetchUser(request.params.id, signal),
      { timeoutMs: 2_000, clone: true },
    );
    response.json(user);
  } catch (error) {
    next(error);
  }
});
```

### Prisma or Drizzle

```ts
export function getUser(id: string) {
  return singleFlight.do(
    `db:user:${id}`,
    async () => prisma.user.findUnique({ where: { id } }),
    { timeoutMs: 1_500, clone: true },
  );
}
```

The timeout releases waiting callers. Configure the database driver's own timeout when the query library does not accept an `AbortSignal`.

### Redis cache-aside

```ts
const getProduct = singleFlight.wrap(
  async (id: string) => {
    const key = `product:${id}`;
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as Product;

    const product = await loadProductFromDatabase(id);
    await redis.set(key, JSON.stringify(product), 'EX', 60);
    return product;
  },
  { keyFn: (id) => `product:${id}`, clone: true },
);
```

This protects cache misses inside one Node process. Redis locks are needed for cross-process stampede protection.

## Deterministic keys

`serializeKey(value)` handles primitives, arrays, sorted plain-object keys, `Date`, `RegExp`, `BigInt`, `Map`, `Set`, and circular references.

```ts
serializeKey({ b: 2, a: 1 }) === serializeKey({ a: 1, b: 2 }); // true
serializeKey(new Set(['b', 'a'])) === serializeKey(new Set(['a', 'b'])); // true
serializeKey(123n); // includes "123n"
```

## Benchmark

```bash
npm run bench
```

The benchmark compares 200 concurrent callers doing a simulated 10 ms operation:

| Scenario | Upstream executions in one burst | Approx. heap delta |
| --- | ---: | ---: |
| Without coalescing | 200 | +215 KiB |
| With `SingleFlight` | 1 | +137 KiB |

Numbers vary by machine and garbage-collection timing. The important result is the upstream work: one shared flight replaces 200 duplicate calls.

## API reference

### Package exports

| Export | Purpose |
| --- | --- |
| `BatchFlight<K, V>` | Adaptive time-window and size-based micro-batching. |
| `BatchOptions<K>` | Batch size, window, serializer, and timeout settings. |
| `CacheAdapter<T>` | Storage interface for `StampedeShield`. |
| `MemoryCacheAdapter<T>` | Bounded in-memory LRU adapter. |
| `serializeKey` | Deterministic key serializer. |
| `SingleFlight` | Isolated in-flight registry. |
| `singleFlight` / `defaultSingleFlight` | Process-wide shared registry. |
| `FlightOptions<T>` / `FlightResult<T>` | Single-flight settings and metadata. |
| `StampedeShield<T>` | XFetch and stale-while-revalidate cache wrapper. |
| `ShieldEnvelope<T>` / `ShieldOptions<T>` | Shield storage metadata and settings. |

### SingleFlight

| Member | Signature | What it does |
| --- | --- | --- |
| `do` | `<T>(key, fn, options?) => Promise<T>` | Join or start one operation. |
| `doWithMeta` | `<T>(key, fn, options?) => Promise<FlightResult<T>>` | Also returns `shared` and `coalescedCount`. |
| `wrap` | `<Args, T>(fn, options?) => (...args: Args) => Promise<T>` | Create a keyed coalescing function. |
| `forget` | `(key) => boolean` | Evict and abort a current flight. |
| `inFlightCount` | `number` | Current number of registered keys. |

`FlightOptions<T>` supports `timeoutMs`, `clone`, and `maxFlightWindowMs`.

### StampedeShield

| Member | Signature | What it does |
| --- | --- | --- |
| constructor | `new StampedeShield<T>(cache?, singleFlight?)` | Configure storage and an optional isolated registry. |
| `getOrSet` | `(key, loader, options?) => Promise<T>` | Read fresh/stale data or coalesce a loader. |
| `MemoryCacheAdapter` | `new MemoryCacheAdapter<T>(maxEntries?)` | Bounded LRU storage; default capacity is 1,000. |

`ShieldOptions<T>` supports `ttlMs` (default 60 seconds), `staleTtlMs` (default 0), `beta` (default 1), `timeoutMs`, `clone`, `maxFlightWindowMs`, and `onBackgroundError`.

### BatchFlight

| Member | Signature | What it does |
| --- | --- | --- |
| constructor | `new BatchFlight<K, V>(batchFn, options?)` | Create a batch coordinator. |
| `load` | `(key: K) => Promise<V>` | Queue one key and return its value. |
| `loadMany` | `(keys: readonly K[]) => Promise<Array<V \| Error>>` | Queue many keys and preserve order. |

`BatchOptions<K>` supports `maxBatchSize` (default 50), `maxWindowMs` (default 10), `keySerializer`, and `timeoutMs`.

## Failure behavior

- Loader failures reject all callers waiting on that flight or batch.
- A timeout aborts the signal and releases the waiting callers.
- `StampedeShield` keeps stale data when a background refresh fails and calls `onBackgroundError`.
- `BatchFlight` rejects only keys whose result is an `Error`; an array alignment failure rejects the whole batch.
- All registries are process-local. Use shared coordination for multiple workers or pods.

## Development

```bash
npm install
npm run build
npm test
npm run bench
npm run check:exports
```
