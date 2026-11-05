<p align="center">
  <img src="./assets/logo.png" alt="flight-shield" width="128" />
</p>

<h1 align="center">flight-shield</h1>

<p align="center">Stop your server from doing the same work twice.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/flight-shield"><img src="https://img.shields.io/npm/v/flight-shield?color=22c55e&label=npm" alt="npm"/></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-333" alt="node"/>
  <img src="https://img.shields.io/badge/zero-dependencies-orange" alt="zero deps"/>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"/>
</p>

---

100 users request the same product at once → your server fires 100 DB queries for the same row. `flight-shield` turns that into **one**.

## Install

```bash
npm install flight-shield
```

---

## SingleFlight — deduplicate concurrent calls

> Many callers, one upstream call. All share the result.

```ts
import { singleFlight } from 'flight-shield';

// 100 requests for user:42 → 1 DB query, 99 callers wait and share
const user = await singleFlight.do(
  `user:${id}`,
  (signal) => db.getUser(id, signal),
  { timeoutMs: 2_000, clone: true },
);
```

**`clone: true`** — each caller gets their own copy (no shared mutation risk).

Wrap any function so it auto-deduplicates by arguments:

```ts
const getUser = singleFlight.wrap(
  async (id: string) => db.getUser(id),
  { keyFn: (id) => `user:${id}`, clone: true },
);
```

---

## StampedeShield — cache with zero-wait refresh

> Serve stale data instantly. Refresh in the background. Never block callers.

When a cached value expires, without protection every request rushes to refill it at once — a **cache stampede**. `StampedeShield` prevents this:

```ts
import { MemoryCacheAdapter, StampedeShield } from 'flight-shield';

const shield = new StampedeShield(new MemoryCacheAdapter(10_000));

const product = await shield.getOrSet(
  `product:${id}`,
  (signal) => db.getProduct(id, signal),
  {
    ttlMs: 30_000,       // fresh for 30s
    staleTtlMs: 120_000, // serve stale for 2min while refreshing in background
    clone: true,
    onBackgroundError: (err, key) => logger.warn({ err, key }),
  },
);
```

For Redis or any shared store — implement the two-method `CacheAdapter<T>` interface:

```ts
class RedisAdapter<T> implements CacheAdapter<T> {
  async get(key: string) { /* return { value, expiresAt } or undefined */ }
  async set(key: string, envelope: ShieldEnvelope<T>) { /* store it */ }
}
```

---

## BatchFlight — group individual loads into one batch call

> Collect 50 `.load()` calls within 10ms → fire one batch request.

```ts
import { BatchFlight } from 'flight-shield';

const users = new BatchFlight<number, User>(
  async (ids, signal) => {
    const res = await fetch('/api/users/batch', {
      method: 'POST', body: JSON.stringify({ ids }), signal,
    });
    return res.json(); // array in same order as ids, or a Map<id, User>
  },
  { maxBatchSize: 50, maxWindowMs: 10 },
);

// Three separate calls → automatically merged into ONE request
const [alice, bob] = await Promise.all([users.load(1), users.load(2)]);

// Load many — per-item errors don't fail the whole batch
const results = await users.loadMany([1, 2, 3]);
// → [User, Error, User]  ← only key 2 failed
```

---

## Deterministic keys

`serializeKey` turns any value into a stable string — object key order doesn't matter:

```ts
import { serializeKey } from 'flight-shield';

serializeKey({ b: 2, a: 1 }) === serializeKey({ a: 1, b: 2 }); // true
serializeKey(new Set(['b', 'a'])) === serializeKey(new Set(['a', 'b'])); // true
```

---

## Benchmark

```
200 concurrent callers, 10ms simulated operation:

Without coalescing   → 200 upstream calls   +215 KiB heap
With SingleFlight    →   1 upstream call     +137 KiB heap
```

Run it: `npm run bench`

---

## API quick reference

### SingleFlight

| Method | Description |
|--------|-------------|
| `singleFlight.do(key, fn, opts?)` | Deduplicate by key |
| `singleFlight.doWithMeta(key, fn, opts?)` | Also returns `shared`, `coalescedCount` |
| `singleFlight.wrap(fn, opts?)` | Auto-keyed wrapper function |
| `singleFlight.forget(key)` | Abort + evict a running flight |

Options: `timeoutMs`, `clone`, `maxFlightWindowMs`

### StampedeShield

| Method | Description |
|--------|-------------|
| `new StampedeShield(cache?, sf?)` | Create shield |
| `shield.getOrSet(key, loader, opts?)` | Cached, coalesced, stale-aware fetch |

Options: `ttlMs`, `staleTtlMs`, `beta`, `timeoutMs`, `clone`, `onBackgroundError`

### BatchFlight

| Method | Description |
|--------|-------------|
| `new BatchFlight(batchFn, opts?)` | Create batch coordinator |
| `batch.load(key)` | Queue one key |
| `batch.loadMany(keys[])` | Queue many keys, returns `Array<Value \| Error>` |

Options: `maxBatchSize` (50), `maxWindowMs` (10ms), `keySerializer`, `timeoutMs`

---

## Error behavior

- **Loader throws** → all waiting callers get the error
- **Timeout** → aborts the signal, rejects all waiters
- **StampedeShield background refresh fails** → keeps serving stale, calls `onBackgroundError`
- **BatchFlight item fails** → only that key rejects, rest resolve fine

> Everything is process-local. For multi-pod setups, pair with distributed locks.

---

## Development

```bash
npm install && npm run build && npm test && npm run bench
```

MIT © Mayank
