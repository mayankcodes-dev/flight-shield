# Changelog

All notable changes to `flight-shield` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [3.4.0] — 2026-11-25

### Added

- **`waitUntil` option on `StampedeShield.getOrSet()`**
  Passes the background SWR refresh promise to the platform's `waitUntil` hook
  (Vercel, Cloudflare Workers, Next.js App Router). Without this, serverless
  runtimes kill the in-flight refresh the moment the HTTP response is sent.
  ```ts
  shield.getOrSet(key, loader, { waitUntil: ctx.waitUntil.bind(ctx) });
  ```

- **`shouldCache` predicate on `StampedeShield.getOrSet()`**
  Return `false` to skip writing a result to the cache without affecting what
  the caller receives. Prevents cache-penetration attacks where bots request
  invalid keys that always miss, filling the cache with `null` entries.
  ```ts
  shield.getOrSet(key, loader, { shouldCache: (val) => val !== null });
  ```

- **Dynamic `ttlMs` on `StampedeShield.getOrSet()`**
  `ttlMs` now accepts `number | ((value: T) => number)`. Use the function form
  to assign different cache lifetimes based on the loaded value — e.g. a 5 s
  TTL for cache misses and a 5 min TTL for real objects.
  ```ts
  shield.getOrSet(key, loader, {
    ttlMs: (val) => val === null ? 5_000 : 300_000,
  });
  ```
  Returning `0` skips caching entirely for that call.

- **`StampedeShield.softPurge(key)`**
  Stampede-safe cache invalidation. After a DB mutation, `cache.delete(key)`
  removes the entry entirely and causes a thundering herd on the next burst.
  `softPurge` zeroes out only the *fresh* window (`expiry = 0`) while keeping
  the *stale* window alive — the next read returns the stale value instantly
  and triggers exactly one coalesced background refresh.
  ```ts
  await db.updateProduct(id, data);
  await shield.softPurge(`product:${id}`); // zero stampede
  ```

- **`AGENTS.md`** — guidance file for AI coding assistants (Copilot, Cursor,
  Gemini, Claude Code). Included in the published npm tarball.

- **`llms.txt`** — machine-readable package description following the emerging
  `llms.txt` convention. Included in the published npm tarball.

### Tests

- 12 new tests covering all four features (3 × `shouldCache`, 2 × `waitUntil`,
  3 × dynamic `ttlMs`, 4 × `softPurge`). Total: **63 tests**.

---

## [3.3.0] — 2026-11-23

### Fixed — BatchFlight & serializeKey (12 bugs total across v3.1–v3.3)

- **Bug 3.1 — Duplicate key safety in BatchFlight**
  Concurrent `load(1)` calls within the same window now share a single
  `waiters[]` array per deduplicated key. Previously a second `load(1)` could
  overwrite the first caller's resolver, leaving it pending forever.

- **Bug 3.2 — Map missing-key routes through `resolveEntry`**
  When `batchFn` returns a `Map` and a key is absent, the error is now
  wrapped in `BatchItemError` and routed through `resolveEntry()` so
  `loadMany()` returns a per-item `Error` instead of crashing the whole batch.
  Map lookups now try `rawKey` first then fall back to `serializedKey`.

- **Bug 3.3 — `loadMany([])` short-circuits**
  An empty array now returns `Promise.resolve([])` immediately without
  starting a batch timer or invoking `batchFn`.

- **Bug 3.4 — `serializeKey` edge-case crashes and collisions**
  - `BigInt` — previously threw `TypeError` from `JSON.stringify`
  - Circular objects — previously threw `RangeError: Maximum call stack size exceeded`
  - `Date` / `RegExp` — previously serialized to `"{}"` and collided
  - `NaN` / `Infinity` / `-Infinity` — previously all serialized to `"null"`
  - `Set([1, '1'])` — number and string elements now type-tagged (`n:1`, `s:1`)

### Tests

- 16 new regression tests (3 × dedup safety, 3 × Map lookup, 2 × empty
  `loadMany`, 10 × `serializeKey` edge cases). Total: **51 tests**.

---

## [3.2.0] — 2026-11-22

### Fixed — StampedeShield hardening

- **Bug 2.1 — Double background refresh race**
  A foreground cold miss coalescing with a running background refresh could
  trigger a second `startBackgroundRefresh`. Fixed with a `backgroundRefreshes`
  Set guard checked before every `singleFlight.do()` call.

- **Bug 2.2 — NaN trap in XFetch probabilistic expiry**
  `Math.random()` can return exactly `0`; `Math.log(0) = -Infinity`;
  `-Infinity * deltaMs * beta = NaN`; the refresh comparison silently
  evaluates to `false` and the XFetch early-refresh never fires.
  Fixed by clamping `Math.random()` to `≥ Number.EPSILON` and `deltaMs`
  to `≥ 1 ms`.

- **Bug 2.3 — Redis physical TTL discards `staleTtlMs`**
  `cache.set()` was called with `pxMs = ttlMs` only. Entries expired from
  the physical store before the stale window closed. Fixed: `pxMs = ttlMs + staleTtlMs`.
  `ShieldEnvelope` and `CacheAdapter` JSDoc updated for adapter authors.

- **Bug 2.4 — Unhandled rejection on background refresh failure**
  When `onBackgroundError` was omitted and the background loader threw, the
  rejection was unhandled. Now silently swallowed when no handler is provided;
  the handler's own throws are also caught.

### Tests

- 10 new tests. Total: **35 tests**.

---

## [3.1.0] — 2026-11-22

### Fixed — SingleFlight concurrency bugs

- **Bug 1.1 — ABA race in `removeEntry` / `forget()`**
  A flight completing at the same moment a new flight starts for the same key
  could cause the cleanup path to delete the new entry. Fixed by capturing a
  reference to the entry at creation and comparing with `===` before deletion.
  `forget()` now evicts without aborting; use `abort()` for hard cancellation.

- **Bug 1.2 — `structuredClone` throws `DataCloneError`**
  `clone: true` now wraps `structuredClone` in a try/catch and falls back to
  JSON round-trip then identity, so non-transferable values (functions,
  Symbols, Proxies, WeakMaps) don't crash all waiting callers.

- **Bug 1.3 — Timers and listeners keeping Node.js alive**
  All `setTimeout` calls are now `.unref()`'d. All `AbortSignal` listeners
  use `{ once: true }` and are explicitly removed in `removeEntry`.

- **Bug 1.4 — `wrap()` keying and `this` context loss**
  `wrap()` now uses `fn.apply(receiver, args)` to preserve method receiver
  context. The default serialized key includes `args.length` to distinguish
  zero-arg calls from explicit `undefined` arguments.

### Tests

- Initial 23 tests covering all four bug regressions plus core behaviour.

---

## [3.0.0] — 2026-11-04

### Added

- Initial public release with `SingleFlight`, `StampedeShield`,
  `BatchFlight`, `MemoryCacheAdapter`, and `serializeKey`.
- Full ESM + CJS dual build with 100% TypeScript type parity.
- Zero runtime dependencies.
- XFetch probabilistic early-expiry algorithm (Vattani et al., 2015).
- DataLoader-compatible `batchFn` API (Array or Map response).
- `AbortSignal` propagation through all three primitives.

---

[3.4.0]: https://github.com/mayankcodes-dev/flight-shield/compare/v3.3.0...v3.4.0
[3.3.0]: https://github.com/mayankcodes-dev/flight-shield/compare/v3.2.0...v3.3.0
[3.2.0]: https://github.com/mayankcodes-dev/flight-shield/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/mayankcodes-dev/flight-shield/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/mayankcodes-dev/flight-shield/releases/tag/v3.0.0
