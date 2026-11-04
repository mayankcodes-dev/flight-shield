# flight-shield

`flight-shield` is a zero-runtime-dependency TypeScript library for preventing duplicate asynchronous work in Node.js. It combines process-local request coalescing, deterministic cache keys, timeouts, and per-caller result isolation in a small dual ESM/CJS package.

```text
many callers ──┐
               ├── SingleFlight ── one upstream request
many callers ──┘
```

Requires Node.js 20 or newer.

## Why this exists

### Thundering herds and cache stampedes

A **thundering herd** happens when many requests need the same expensive value at once. A cold start, traffic spike, or popular endpoint can turn one logical lookup into hundreds of database, HTTP, or filesystem operations.

A **cache stampede** is the cache-specific version: a hot value expires or is missing, every request sees the miss, and every request refills the same key independently. The cache may be fast while the origin database becomes the bottleneck.

`SingleFlight` keeps one in-flight operation per key. All callers await that operation, so the upstream sees one execution while the application still serves every caller.

### Why a naive `Map<string, Promise>` is not enough

A hand-written promise map often starts like this:

```ts
const pending = new Map<string, Promise<unknown>>();
```

Two failure modes are easy to miss:

1. **Hung work retains state.** If a socket or driver promise never settles, its key, promise, closures, and captured request data remain reachable forever. A cleanup callback attached to resolution/rejection never runs. `flight-shield` can race the operation against `AbortSignal.timeout()` and evict the key immediately; `maxFlightWindowMs` also lets late callers start a fresh flight while an old one is still degraded.
2. **Shared mutable results corrupt callers.** A promise map returns the exact same object to every waiter. If one handler mutates a nested field, another handler can observe that mutation or race with it. Set `clone: true` to use `structuredClone` for each caller, or provide a domain-specific clone function.

Failures and timeouts evict the key as soon as the shared promise settles or aborts. A subsequent caller therefore cannot be permanently attached to a dead flight.

## Install

```bash
npm install flight-shield
```

The package has no runtime dependencies and provides both ESM and CommonJS entry points:

```ts
import { singleFlight } from 'flight-shield';
```

```js
const { singleFlight } = require('flight-shield');
```

The default singleton is stored on `globalThis[Symbol.for('flight-shield.default')]`, so ESM and CJS imports in the same process share one flight registry.

## Quick start

```ts
import { singleFlight } from 'flight-shield';

const user = await singleFlight.do(
  'user:42',
  (signal) => fetch('https://users.internal/42', { signal }).then((response) => {
    if (!response.ok) throw new Error(`User service returned ${response.status}`);
    return response.json() as Promise<{ id: string; name: string }>;
  }),
  { timeoutMs: 2_000, clone: true },
);
```

For structured keys, use `serializeKey` directly or let `wrap` serialize its arguments:

```ts
import { serializeKey, singleFlight } from 'flight-shield';

const key = serializeKey({ tenantId: 'acme', userId: 42 });
const getUser = singleFlight.wrap(
  async (tenantId: string, userId: number) => loadUser(tenantId, userId),
  {
    keyFn: (tenantId, userId) => serializeKey({ tenantId, userId }),
    clone: true,
  },
);
```

## Backend recipes

### Express route handler

Pass the request signal to an upstream client that supports cancellation. `clone: true` is useful when middleware or response shaping mutates the returned object.

```ts
import express from 'express';
import { singleFlight } from 'flight-shield';

const app = express();

app.get('/users/:id', async (request, response, next) => {
  try {
    const { id } = request.params;
    const user = await singleFlight.do(
      `user:${id}`,
      (signal) => fetch(`https://users.internal/users/${id}`, { signal }).then((result) => {
        if (!result.ok) throw new Error(`User service returned ${result.status}`);
        return result.json();
      }),
      { timeoutMs: 2_000, clone: true },
    );

    response.json(user);
  } catch (error) {
    next(error);
  }
});
```

### Fastify route handler

```ts
import Fastify from 'fastify';
import { singleFlight } from 'flight-shield';

const fastify = Fastify();

fastify.get<{ Params: { id: string } }>('/users/:id', async (request) => {
  const { id } = request.params;

  return singleFlight.do(
    `user:${id}`,
    (signal) => fetch(`https://users.internal/users/${id}`, { signal }).then((result) => {
      if (!result.ok) throw new Error(`User service returned ${result.status}`);
      return result.json();
    }),
    { timeoutMs: 2_000, clone: true },
  );
});

await fastify.listen({ port: 3000 });
```

### Prisma query

Use a stable key for the query shape. Prisma calls that do not accept an `AbortSignal` can still use `timeoutMs` to release waiting callers and the key; configure the database/client timeout separately when you need to stop the underlying query itself.

```ts
import { PrismaClient } from '@prisma/client';
import { singleFlight } from 'flight-shield';

const prisma = new PrismaClient();

export function getUser(id: string) {
  return singleFlight.do(
    `prisma:user:${id}`,
    async () => prisma.user.findUnique({ where: { id } }),
    { timeoutMs: 1_500, clone: true },
  );
}
```

### Drizzle query

```ts
import { eq } from 'drizzle-orm';
import { singleFlight } from 'flight-shield';
import { db } from './db.js';
import { users } from './schema.js';

export function getUser(id: string) {
  return singleFlight.do(
    `drizzle:user:${id}`,
    async () => db.select().from(users).where(eq(users.id, id)).limit(1),
    { timeoutMs: 1_500, clone: true },
  );
}
```

### Redis / ioredis cache-aside wrapper

This collapses concurrent local cache misses. The Redis cache remains the shared cache; a multi-process deployment needs a distributed lock or Redis-side coordination if misses must collapse across workers or pods.

```ts
import Redis from 'ioredis';
import { singleFlight } from 'flight-shield';

const redis = new Redis(process.env.REDIS_URL);

const getProduct = singleFlight.wrap(
  async (id: string) => {
    const cacheKey = `product:${id}`;
    const cached = await redis.get(cacheKey);
    if (cached !== null) return JSON.parse(cached) as Product;

    const product = await loadProductFromDatabase(id);
    await redis.set(cacheKey, JSON.stringify(product), 'EX', 60);
    return product;
  },
  {
    keyFn: (id) => `product:${id}`,
    timeoutMs: 2_000,
    clone: true,
  },
);

const product = await getProduct('sku-42');
```

## Benchmarks

Run the benchmark with:

```bash
npm run bench
```

It builds the package, measures deterministic key serialization, then compares 200 concurrent callers against a simulated 10 ms upstream task with and without coalescing. The custom summary reports upstream executions and the approximate `heapUsed` delta for one 200-caller burst. Memory numbers are runtime- and GC-dependent; run with `node --expose-gc` manually when you need a more controlled comparison.

### Captured output

Captured with `npm run bench` on Node 22.17.0, Windows x64, AMD Ryzen 5 5600H:

```text
benchmark                                 avg (min … max) p75 / p99    (min … top 1%)
--------------------------------------------------------- -------------------------------
serializeKey: nested object + BigInt + Map  26.56 µs/iter  32.30 µs █
                                     (15.30 µs … 1.42 ms)  93.00 µs █
                                  (  1.00 kb … 381.19 kb)  13.08 kb █▆▃▄▄▄▄▃▂▂▁▁▁▁▁▁▁▁▁▁▁

200 callers: without coalescing             16.73 ms/iter  17.54 ms        █
                                     (12.47 ms … 23.97 ms)  23.57 ms       ▃██
                                  (217.68 kb …   1.73 mb) 315.92 kb ▆▄▄▁▆▆███▆█▁█▄▁▁▁▁▁▁▄

200 callers: with SingleFlight              15.97 ms/iter  18.11 ms         █
                                     (10.81 ms … 23.58 ms)  21.43 ms      ▅▅ █  █
                                  (137.34 kb … 356.05 kb) 144.69 kb ▅▅█▅███▅█▅▅██▁██▅██▁▅
```

Mitata-derived throughput and the one-burst resource summary from the same run:

| Benchmark | Average latency | Approx. throughput |
| --- | ---: | ---: |
| serializeKey: nested object + BigInt + Map | 26.56 µs | 37,645.61 ops/s |
| 200 callers: without coalescing | 16.73 ms | 59.77 ops/s |
| 200 callers: with SingleFlight | 15.97 ms | 62.60 ops/s |

| Scenario | Upstream DB executions | Heap delta | Burst latency |
| --- | ---: | ---: | ---: |
| without coalescing | 200 | +215.05 KiB | 14.01 ms |
| with SingleFlight | 1 | +137.35 KiB | 25.05 ms |

The important result is upstream pressure: one flight replaces 200 upstream executions. The end-to-end burst latency remains close to the simulated I/O latency because callers already overlap while waiting for the shared result.

## Deterministic keys

`serializeKey(input)` returns a type-tagged deterministic string. It supports:

- primitives, including `NaN`, infinities, `-0`, symbols, and `undefined`;
- arrays with order and sparse holes preserved;
- plain objects with lexicographically sorted keys;
- `Date` and `RegExp`;
- `BigInt` values with an `n` suffix;
- `Map` entries sorted by serialized key/value pairs;
- `Set` values sorted by their serialized values; and
- circular references represented by stable `ref:<index>` markers instead of throwing.

```ts
import { serializeKey } from 'flight-shield';

serializeKey({ b: 2, a: 1 }) === serializeKey({ a: 1, b: 2 }); // true
serializeKey(new Set(['b', 'a'])) === serializeKey(new Set(['a', 'b'])); // true
serializeKey(123n); // contains "123n"
```

Use an explicit `keyFn` when a function's arguments contain values whose identity or semantics should not be represented by serialization.

## TypeScript API reference

All public exports are available from the package root.

### Package exports

| Export | Type | Purpose |
| --- | --- | --- |
| `serializeKey` | `(input: unknown) => string` | Build a deterministic key from a structured value. |
| `SingleFlight` | `class` | Create an isolated in-flight registry. |
| `singleFlight` | `SingleFlight` | Process-wide default singleton. |
| `defaultSingleFlight` | `SingleFlight` | Alias of `singleFlight`. |
| `FlightOptions<T>` | `interface` | Configure timeout, result cloning, and the flight window. |
| `FlightResult<T>` | `interface` | Metadata returned by `doWithMeta`. |
| `flightShield` | `"flight-shield"` | Package marker retained from the initial scaffold. |

### `SingleFlight`

| Member | Signature | Description |
| --- | --- | --- |
| constructor | `new SingleFlight()` | Create an independent registry instead of using the process-wide singleton. |
| `doWithMeta` | `<T>(key: string, fn: (signal: AbortSignal) => Promise<T>, options?: FlightOptions<T>) => Promise<FlightResult<T>>` | Join an existing flight or start one, returning the value plus sharing metadata. |
| `do` | `<T>(key: string, fn: (signal: AbortSignal) => Promise<T>, options?: FlightOptions<T>) => Promise<T>` | Join or start a flight and return only the resolved value. |
| `wrap` | `<Args extends unknown[], T>(fn: (...args: Args) => Promise<T>, options?: FlightOptions<T> & { keyFn?: (...args: Args) => string }) => (...args: Args) => Promise<T>` | Turn an async function into a coalescing function. Uses `serializeKey(args)` by default; `keyFn` can provide a domain key. |
| `forget` | `(key: string) => boolean` | Evict and abort a current flight. Returns `true` when a flight existed. |
| `inFlightCount` | `number` | Read-only count of currently registered keys. |

### `FlightOptions<T>`

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `timeoutMs` | `number` | no timeout | Compose the caller controller with `AbortSignal.timeout(timeoutMs)`. On timeout, all waiters reject and the key is evicted immediately. |
| `clone` | `boolean \| ((val: T) => T)` | `undefined` | `true` applies `structuredClone` to each caller's result. A function provides a custom per-caller clone. |
| `maxFlightWindowMs` | `number` | no window | Evict the key after this many milliseconds even if the upstream promise remains pending. The Node timer is `unref()`'d. The old operation is not forcibly cancelled by this option. |

Durations must be finite and non-negative. The callback receives the signal that should be passed to `fetch` or another signal-aware client. If an upstream library ignores the signal, `timeoutMs` still releases the shared waiters and the key, but the underlying operation may finish later.

### `FlightResult<T>`

| Property | Type | Description |
| --- | --- | --- |
| `value` | `T` | The resolved value, optionally cloned for this caller. |
| `shared` | `boolean` | `true` when at least two callers joined the same flight. |
| `coalescedCount` | `number` | Number of callers attached to that flight when it resolved. |

Example:

```ts
const result = await singleFlight.doWithMeta(
  'settings:acme',
  async () => loadSettings('acme'),
  { clone: true },
);

console.log(result.shared, result.coalescedCount, result.value);
```

## Failure and lifecycle behavior

- A rejection from the callback propagates to every waiter and removes the key.
- A timeout aborts the shared signal, rejects every waiter with the abort reason, and removes the key immediately.
- `forget(key)` removes the entry and aborts its controller. It returns `false` when no matching flight exists.
- `maxFlightWindowMs` removes only the registry entry. A late caller starts a new operation while the previous callback may still be running.
- A completed or rejected flight is not retained in the registry; `inFlightCount` returns to zero after cleanup.
- The registry is process-local. In a multi-worker or multi-pod deployment, each process needs its own coordination strategy if duplicate work must be prevented globally.

## Development

```bash
npm install
npm run build
npm test
npm run bench
npm run check:exports
```

The package publishes only `dist/` and `package.json`; benchmark and test sources remain development files.
