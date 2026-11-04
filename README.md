<p align="center">
  <img src="./assets/logo.png" alt="flight-shield" width="140" />
</p>

<h1 align="center">flight-shield</h1>

<p align="center">
  Stop your server from doing the same work twice.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/flight-shield"><img src="https://img.shields.io/npm/v/flight-shield?color=6366f1&label=npm" alt="npm version"/></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-blue" alt="node 20+"/>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"/>
  <img src="https://img.shields.io/badge/zero-dependencies-orange" alt="zero dependencies"/>
  <img src="https://img.shields.io/badge/TypeScript-ready-3178c6" alt="TypeScript"/>
</p>

---

## What problem does this solve?

Imagine 100 users request the same product page at the same moment. Without `flight-shield`, your server fires 100 database queries for the same row. With it — just one.

This is called a **thundering herd**, and it's one of the most common causes of unexpected database overload in real apps.

`flight-shield` gives you three weapons to fight it:

| Tool | What it does |
|------|-------------|
| **SingleFlight** | If 100 requests need the same key, run the fetch **once** and share the result |
| **StampedeShield** | Wrap your cache so it never floods your DB when a cached value expires |
| **BatchFlight** | Collect individual lookups into a single batch request automatically |

---

## Install

```bash
npm install flight-shield
```

```ts
// ESM
import { singleFlight } from 'flight-shield';

// CommonJS
const { singleFlight } = require('flight-shield');
```

No configuration needed. It works out of the box.

---

## Tool 1 — SingleFlight

> **"100 requests, 1 database call."**

When many requests arrive for the same key at the same time, `SingleFlight` lets only **one** through. The rest wait and share the result.

```ts
import { singleFlight } from 'flight-shield';

const user = await singleFlight.do(
  `user:${userId}`,                              // unique key
  (signal) => fetchUserFromDB(userId, signal),   // the real work
  { timeoutMs: 2_000, clone: true },             // options
);
```

That's it. If 50 requests come in for `user:42` while the fetch is running, they all receive the same result — but the database is only called once.

**`clone: true`** gives each caller their own copy so they can't accidentally modify each other's data.

### Wrap a function

```ts
const getUser = singleFlight.wrap(
  async (id: string) => fetchUserFromDB(id),
  { keyFn: (id) => `user:${id}`, clone: true },
);

// Now safe to call from anywhere — deduped automatically
const user = await getUser('42');
```

---

## Tool 2 — StampedeShield

> **"Your cache expires. Don't let 100 requests hit your DB at once."**

When a cached item expires, every concurrent request rushes to refill it — a **cache stampede**. `StampedeShield` prevents this by:

1. Serving **fresh** values instantly
2. Serving **stale** values while refreshing in the background (zero wait)
3. Only running **one refresh** even if hundreds of requests arrive at the same time

```ts
import { MemoryCacheAdapter, StampedeShield } from 'flight-shield';

const shield = new StampedeShield(new MemoryCacheAdapter(10_000));

const product = await shield.getOrSet(
  'product:42',
  (signal) => fetchProductFromDB('42', signal),
  {
    ttlMs: 30_000,       // fresh for 30 seconds
    staleTtlMs: 120_000, // serve stale for up to 2 minutes while refreshing
    clone: true,
  },
);
```

**`MemoryCacheAdapter`** is an in-process LRU cache (bounded). For Redis or another shared store, implement the small `CacheAdapter<T>` interface with `get` and `set` methods.

---

## Tool 3 — BatchFlight

> **"Stop calling your API one item at a time."**

Instead of 50 separate `GET /user/1`, `GET /user/2`… calls, `BatchFlight` automatically groups individual `.load()` calls into a single batch request.

```ts
import { BatchFlight } from 'flight-shield';

const users = new BatchFlight<number, User>(
  async (ids, signal) => {
    // Called once with [1, 2, 3, ...] instead of one-by-one
    const res = await fetch('/api/users/batch', {
      method: 'POST',
      body: JSON.stringify({ ids }),
      signal,
    });
    return res.json(); // return array in same order as ids
  },
  { maxBatchSize: 50, maxWindowMs: 10 }, // collect for 10ms then flush
);

// These three calls become ONE batch request
const [alice, bob, carol] = await Promise.all([
  users.load(1),
  users.load(2),
  users.load(3),
]);
```

You can also load many keys at once and get per-item errors without crashing the whole batch:

```ts
const results = await users.loadMany([1, 2, 3]);
// results[1] could be an Error — the other items still resolve fine
```

---

## Real-world examples

### Express route

```ts
app.get('/users/:id', async (req, res, next) => {
  try {
    const user = await singleFlight.do(
      `user:${req.params.id}`,
      (signal) => fetchUser(req.params.id, signal),
      { timeoutMs: 2_000, clone: true },
    );
    res.json(user);
  } catch (err) {
    next(err);
  }
});
```

### Prisma / Drizzle ORM

```ts
export function getUser(id: string) {
  return singleFlight.do(
    `db:user:${id}`,
    () => prisma.user.findUnique({ where: { id } }),
    { timeoutMs: 1_500, clone: true },
  );
}
```

### Redis cache-aside

```ts
const getProduct = singleFlight.wrap(
  async (id: string) => {
    const cached = await redis.get(`product:${id}`);
    if (cached) return JSON.parse(cached);
    const product = await db.products.find(id);
    await redis.set(`product:${id}`, JSON.stringify(product), 'EX', 60);
    return product;
  },
  { keyFn: (id) => `product:${id}` },
);
```

---

## Deterministic key serialization

`serializeKey` turns any value into a consistent string key — even objects with keys in different order.

```ts
import { serializeKey } from 'flight-shield';

serializeKey({ b: 2, a: 1 }) === serializeKey({ a: 1, b: 2 }); // true
serializeKey(new Set(['b', 'a'])) === serializeKey(new Set(['a', 'b'])); // true
```

Handles: primitives, arrays, plain objects, `Date`, `RegExp`, `BigInt`, `Map`, `Set`, circular references.

---

## Benchmark

```bash
npm run bench
```

| Scenario | DB calls for 200 concurrent requests | Memory |
|----------|-----------------------------------:|-------:|
| No protection | **200** | +215 KiB |
| With `SingleFlight` | **1** | +137 KiB |

---

## API reference

### SingleFlight

| Method | What it does |
|--------|-------------|
| `singleFlight.do(key, fn, options?)` | Deduplicate concurrent calls by key |
| `singleFlight.doWithMeta(key, fn, options?)` | Same, but also returns `shared` and `coalescedCount` |
| `singleFlight.wrap(fn, options?)` | Wrap a function to auto-deduplicate by args |
| `singleFlight.forget(key)` | Abort and evict a running flight |
| `singleFlight.inFlightCount` | How many keys are currently in-flight |

**Options:** `timeoutMs`, `clone`, `maxFlightWindowMs`

---

### StampedeShield

| Method | What it does |
|--------|-------------|
| `new StampedeShield(cache?, sf?)` | Create a shield with optional cache adapter |
| `shield.getOrSet(key, loader, options?)` | Get from cache or run loader (deduplicated) |
| `new MemoryCacheAdapter(maxEntries?)` | Bounded LRU cache (default 1,000 entries) |

**Options:** `ttlMs` (60s), `staleTtlMs` (0), `beta` (1), `timeoutMs`, `clone`, `onBackgroundError`

---

### BatchFlight

| Method | What it does |
|--------|-------------|
| `new BatchFlight(batchFn, options?)` | Create a batch coordinator |
| `batch.load(key)` | Queue a single key — resolves when the batch fires |
| `batch.loadMany(keys[])` | Queue many keys — returns `Array<Value \| Error>` |

**Options:** `maxBatchSize` (50), `maxWindowMs` (10ms), `keySerializer`, `timeoutMs`

---

## Error behavior

- If the loader throws, **all** callers waiting on that flight get the error
- A timeout aborts the signal and rejects all waiting callers
- `StampedeShield` keeps serving stale data if a background refresh fails
- `BatchFlight` per-item errors only reject that key, not the whole batch

> **Note:** Everything here is process-local. For multi-pod/worker setups, pair with Redis locks for distributed coordination.

---

## Development

```bash
npm install
npm run build
npm test
npm run bench
npm run check:exports
```

---

## License

MIT © Mayank
