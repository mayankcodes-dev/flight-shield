<table>
<tr>
<td><img src="./assets/logo.svg" alt="flight-shield logo" width="60" /></td>
<td><h1>flight-shield</h1></td>
</tr>
</table>

Zero-dependency request coalescing, cache-stampede prevention, and adaptive batching for Node.js.

[![npm](https://img.shields.io/npm/v/flight-shield?color=22c55e&label=npm)](https://www.npmjs.com/package/flight-shield)
[![node](https://img.shields.io/badge/node-%3E%3D20-333)](https://nodejs.org)
[![zero dependencies](https://img.shields.io/badge/zero-dependencies-orange)](#install)
[![tests](https://img.shields.io/badge/tests-63%20passing-brightgreen)](./test)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

---

## Install

```sh
npm install flight-shield
```

## Quick Start

```ts
import { singleFlight, StampedeShield, MemoryCacheAdapter, BatchFlight } from 'flight-shield';

// 1 — Collapse N concurrent identical calls into 1
const user = await singleFlight.do(`user:${id}`, (signal) => db.getUser(id, signal));

// 2 — SWR cache: serve stale instantly, refresh once in background
const shield = new StampedeShield(new MemoryCacheAdapter());
const product = await shield.getOrSet(`product:${id}`, (signal) => db.getProduct(id, signal), {
  ttlMs: 30_000,
  staleTtlMs: 120_000,
});

// 3 — Batch N individual loads into one upstream call
const users = new BatchFlight<number, User>((ids) => db.getUsers(ids), { maxBatchSize: 50 });
const alice = await users.load(1);
```

---

## Table of Contents

- [SingleFlight](#singleflight)
- [StampedeShield](#stampeadeshield)
  - [shouldCache](#shouldcache--skip-caching-bad-values)
  - [Dynamic ttlMs](#dynamic-ttlms--value-based-ttl)
  - [waitUntil](#waituntil--serverless-background-refresh)
  - [softPurge](#softpurge--stampede-safe-invalidation)
  - [Redis adapter](#redis-adapter)
- [BatchFlight](#batchflight)
- [serializeKey](#serializekey)
- [Benchmark](#benchmark)
- [API Reference](#api-reference)
- [Error behavior](#error-behavior)
- [FAQ](#faq)

---

## SingleFlight

> `singleFlight` · `SingleFlight` · `defaultSingleFlight`

When *N* concurrent callers request the same key, **one** upstream call is made. All *N* callers receive the same resolved value. Subsequent calls for the same key after resolution each trigger a fresh upstream call.

```ts
import { singleFlight } from 'flight-shield';

const user = await singleFlight.do(
  `user:${id}`,
  (signal) => db.getUser(id, signal),
  { timeoutMs: 2_000, clone: true },
);
```

**`clone: true`** — each caller gets a deep copy via `structuredClone` (falls back to JSON → identity for non-transferable values). Prevents shared-reference mutation bugs across callers.

#### Wrap any async function

```ts
import { singleFlight } from 'flight-shield';

const getUser = singleFlight.wrap(
  async (id: string) => db.getUser(id),
  { keyFn: (id) => `user:${id}`, clone: true },
);

// Concurrent calls with the same id coalesce automatically
const [a, b] = await Promise.all([getUser('42'), getUser('42')]);
```

#### Inspect coalescing metadata

```ts
const { value, shared, coalescedCount } = await singleFlight.doWithMeta(
  `user:${id}`,
  (signal) => db.getUser(id, signal),
);
// shared         → true if this caller piggybacked on an in-flight request
// coalescedCount → total number of callers that shared this flight
```

#### Evict or cancel a key

```ts
singleFlight.forget(key); // evict the key; existing callers still finish normally
singleFlight.abort(key);  // hard-cancel the flight; all waiters receive an error
```

---

## StampedeShield

> `StampedeShield` · `MemoryCacheAdapter`

SWR (stale-while-revalidate) cache layer with XFetch probabilistic early-expiry. Serves stale data instantly while exactly **one** background refresh runs. Prevents cache stampedes on key expiry.

```ts
import { StampedeShield, MemoryCacheAdapter } from 'flight-shield';

const shield = new StampedeShield(new MemoryCacheAdapter(10_000));

const product = await shield.getOrSet(
  `product:${id}`,
  (signal) => db.getProduct(id, signal),
  {
    ttlMs: 30_000,        // fresh for 30 s
    staleTtlMs: 120_000,  // serve stale for 2 min while refreshing in background
    beta: 1,              // XFetch aggressiveness (0 = off, higher = earlier refresh)
    clone: true,
    onBackgroundError: (err, key) => logger.warn({ err, key }),
  },
);
```

`beta` controls the [XFetch algorithm](https://cseweb.ucsd.edu/~avattani/papers/cache_stampede.pdf): it probabilistically triggers a background refresh *before* the TTL expires, eliminating the thundering herd on the TTL boundary entirely.

---

### `shouldCache` — skip caching bad values

Prevents cache-penetration: without this, bots hammering `user:999999` cache every `null` miss for the full TTL, crowding out real entries.

```ts
const user = await shield.getOrSet(`user:${id}`, () => db.getUser(id), {
  ttlMs: 60_000,
  shouldCache: (value) => value !== null,
  // → null/miss results are NOT stored; next call hits the loader again
});
```

---

### Dynamic `ttlMs` — value-based TTL

```ts
const user = await shield.getOrSet(`user:${id}`, () => db.getUser(id), {
  ttlMs: (value) => value === null ? 5_000 : 300_000,
  // → 5 s for a miss, 5 min for a real object
  staleTtlMs: 120_000,
});
```

Returning `0` from the function skips caching entirely for that value.

---

### `waitUntil` — serverless background refresh

Vercel, Cloudflare Workers, and Next.js App Router **terminate background promises** when the HTTP response is sent. Without `waitUntil`, the SWR refresh is silently killed mid-flight.

```ts
// Next.js App Router
import { unstable_after as waitUntil } from 'next/server';
await shield.getOrSet(key, loader, { ttlMs: 60_000, staleTtlMs: 300_000, waitUntil });

// Cloudflare Workers
export default {
  fetch(req, env, ctx) {
    return shield.getOrSet(key, loader, {
      ttlMs: 60_000,
      waitUntil: ctx.waitUntil.bind(ctx),
    });
  },
};
```

---

### `softPurge` — stampede-safe invalidation

After a mutation, `cache.delete(key)` removes the entry entirely. The next burst of readers all miss simultaneously and stampede the DB.

`softPurge` zeroes the *fresh* window (`expiry = 0`) while keeping the *stale* window alive. The next read returns the stale value instantly and kicks off **exactly one** background refresh.

```ts
// ❌ causes stampede on the next read burst
await cache.delete(`product:${id}`);

// ✅ serves stale instantly, one background refresh, no stampede
await shield.softPurge(`product:${id}`);
```

`softPurge` on a missing or already-expired key is a safe no-op.

---

### Redis adapter

Implement the three-method `CacheAdapter<T>` interface to plug in any external store.

```ts
import { createClient } from 'redis';
import type { CacheAdapter, ShieldEnvelope } from 'flight-shield';

const redis = createClient();

class RedisAdapter<T> implements CacheAdapter<T> {
  async get(key: string): Promise<ShieldEnvelope<T> | undefined> {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as ShieldEnvelope<T>) : undefined;
  }

  async set(key: string, envelope: ShieldEnvelope<T>, pxMs: number): Promise<void> {
    // pxMs = ttlMs + staleTtlMs — the total physical lifetime the entry must stay alive
    // Use pxMs here, NOT envelope.expiry — the stale window requires the full duration
    await redis.set(key, JSON.stringify(envelope), { PX: pxMs });
  }

  async delete(key: string): Promise<void> {
    await redis.del(key);
  }
}

const shield = new StampedeShield(new RedisAdapter());
```

---

## BatchFlight

> `BatchFlight`

Collects individual `.load(key)` calls within a configurable time window and fires **one** batched upstream call. Duplicate keys within the same window are deduplicated — `batchFn` receives each key exactly once. Per-item errors do not fail the whole batch.

```ts
import { BatchFlight } from 'flight-shield';

const users = new BatchFlight<number, User>(
  async (ids, signal) => {
    // ids = [1, 2, 5] — deduplicated, never contains duplicates
    return db.query('SELECT * FROM users WHERE id = ANY($1)', [ids], { signal });
    // Return an Array (same order as ids) or a Map<id, User>
  },
  { maxBatchSize: 50, maxWindowMs: 10 },
);

// Separate handler calls → merged into ONE upstream query
const [alice, bob] = await Promise.all([users.load(1), users.load(2)]);

// loadMany — per-item errors don't fail the whole batch
const results = await users.loadMany([1, 2, 3]);
// → [User, Error, User]  ← only key 2 failed; keys 1 and 3 resolved
```

---

## serializeKey

Turns any JavaScript value into a stable, deterministic string. Used internally by `SingleFlight` and `BatchFlight`. Available for external use.

```ts
import { serializeKey } from 'flight-shield';

// Object key order is irrelevant
serializeKey({ b: 2, a: 1 }) === serializeKey({ a: 1, b: 2 }); // true

// Set/Map iteration order is irrelevant
serializeKey(new Set(['b', 'a'])) === serializeKey(new Set(['a', 'b'])); // true
```

Handles: `BigInt`, `Date`, `RegExp`, `Set`, `Map`, circular references, `NaN`, `Infinity`, `-Infinity`, `-0`, `null`, `undefined`, `Symbol`.

---

## Benchmark

Measured on Node.js v22.17.0, AMD Ryzen 5 5600H, 200 concurrent callers, 10 ms simulated I/O:

| Scenario | Upstream DB calls | Heap Δ | Burst latency |
|---|---:|---:|---:|
| Without coalescing | 200 | +232.82 KiB | 26.06 ms |
| **With SingleFlight** | **1** | **+151.70 KiB (−35%)** | **12.68 ms (−51%)** |

During a full sustained-load run: **9,000 upstream calls** without coalescing vs **45 with SingleFlight** — a **99.5% reduction**.

`serializeKey` throughput (nested object + BigInt + Map): **7.97 µs / 125,465 ops/s**.

Reproduce: `npm run bench`

---

## API Reference

### SingleFlight

| Method | Returns | Description |
|--------|---------|-------------|
| `singleFlight.do(key, fn, opts?)` | `Promise<T>` | Deduplicate by key |
| `singleFlight.doWithMeta(key, fn, opts?)` | `Promise<FlightResult<T>>` | Returns value + `shared`, `coalescedCount` |
| `singleFlight.wrap(fn, opts?)` | `typeof fn` | Auto-keyed wrapper |
| `singleFlight.forget(key)` | `void` | Evict key; existing callers finish |
| `singleFlight.abort(key)` | `void` | Hard-cancel; all waiters reject |

**Options** (`FlightOptions<T>`):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeoutMs` | `number` | — | Abort after this many ms |
| `clone` | `boolean \| (val: T) => T` | `false` | Deep-copy the result per caller |
| `maxFlightWindowMs` | `number` | — | Max time a flight may be coalesced |

---

### StampedeShield

| Method | Returns | Description |
|--------|---------|-------------|
| `new StampedeShield(cache?, sf?)` | — | `cache` defaults to `MemoryCacheAdapter(1000)` |
| `shield.getOrSet(key, loader, opts?)` | `Promise<T>` | Cached, coalesced, stale-aware fetch |
| `shield.softPurge(key)` | `Promise<void>` | Stampede-safe invalidation |

**Options** (`ShieldOptions<T>`):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `ttlMs` | `number \| (val: T) => number` | `60_000` | Fresh window. Function form enables value-based TTL |
| `staleTtlMs` | `number` | `0` | Stale-serving window on top of `ttlMs` |
| `beta` | `number` | `1` | XFetch aggressiveness. `0` disables early refresh |
| `shouldCache` | `(val: T) => boolean` | — | Return `false` to skip caching this value |
| `waitUntil` | `(p: Promise<unknown>) => void` | — | Serverless keepalive hook |
| `clone` | `boolean \| (val: T) => T` | `false` | Deep-copy the result per caller |
| `timeoutMs` | `number` | — | Abort the loader after this many ms |
| `onBackgroundError` | `(err, key) => void` | — | Called when a background refresh fails |

---

### BatchFlight

| Method | Returns | Description |
|--------|---------|-------------|
| `new BatchFlight(batchFn, opts?)` | — | Create a batch coordinator |
| `batch.load(key)` | `Promise<V>` | Queue one key |
| `batch.loadMany(keys)` | `Promise<Array<V \| Error>>` | Queue many; per-item errors |

**Options** (`BatchOptions`):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxBatchSize` | `number` | `50` | Flush immediately when this many keys are queued |
| `maxWindowMs` | `number` | `10` | Max ms to wait before flushing |
| `keySerializer` | `(key: K) => string` | `serializeKey` | Custom key → string function |
| `timeoutMs` | `number` | — | Abort the batch after this many ms |

---

## Error Behavior

| Scenario | Outcome |
|----------|---------|
| Loader throws | All waiting callers for that key receive the error |
| `timeoutMs` exceeded | `AbortSignal` fires; all waiters reject |
| Background SWR refresh fails | Stale value continues to be served; `onBackgroundError` is called |
| `batchFn` throws | All keys in that batch reject |
| Single item missing from `batchFn` result | Only that key rejects; rest resolve normally |
| `softPurge` on missing/expired key | No-op; resolves normally |

---

## FAQ

**Is flight-shield distributed?**
No. It is process-local. For multi-pod Kubernetes deployments, pair it with a shared Redis cache (via `CacheAdapter`) and a distributed lock for write operations.

**Can I coalesce write operations?**
No. `INSERT`, `UPDATE`, and `DELETE` have per-caller semantics. Only coalesce reads where all callers expect the same result.

**Does it work in Cloudflare Workers / edge runtimes?**
Yes, with `waitUntil`. Without it, background refreshes are killed when the response is sent.

**What happens if `batchFn` returns fewer items than keys?**
The entire batch rejects with a descriptive `TypeError`. Implement `batchFn` to always return one result per key (array in the same order, or a `Map` keyed by the input keys).

**What does `clone: true` do when the value is not cloneable?**
`structuredClone` is tried first. On `DataCloneError` (functions, Symbols, Proxies), it falls back to `JSON.parse(JSON.stringify(value))`. If that also fails, the original reference is returned unchanged.

---

## Development

```sh
npm install
npm run build   # ESM + CJS + TypeScript declarations
npm test        # 63 regression tests
npm run bench   # coalescing benchmarks
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.

---

MIT © Mayank
