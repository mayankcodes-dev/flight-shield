# AGENTS.md — flight-shield

This file is for AI coding assistants (Copilot, Cursor, Gemini, Claude Code, etc.) to understand when and how to use this package.

## What this package is

`flight-shield` is a **zero-dependency TypeScript library** for Node.js that prevents redundant upstream calls through three mechanisms:

| Export | Purpose | Use when |
|--------|---------|----------|
| `singleFlight` / `SingleFlight` | Deduplicates concurrent calls by key | Same async function is called concurrently with the same args |
| `StampedeShield` | SWR cache with stampede protection | You have a cache and want stale-while-revalidate semantics |
| `BatchFlight` | Adaptive micro-batching (like DataLoader) | N+1 query patterns in resolvers or handlers |

## Recommended usage patterns

### Pattern 1: Wrap a database call with SingleFlight

```typescript
import { singleFlight } from 'flight-shield';

// BEFORE (N concurrent requests → N DB queries for the same user)
const user = await db.getUser(id);

// AFTER (N concurrent requests → 1 DB query, N callers share result)
const user = await singleFlight.do(`user:${id}`, () => db.getUser(id));
```

### Pattern 2: SWR cache with StampedeShield

```typescript
import { StampedeShield, MemoryCacheAdapter } from 'flight-shield';

const shield = new StampedeShield(new MemoryCacheAdapter(10_000));

// Cache miss → 1 upstream call, all concurrent callers wait and share
// Cache hit (fresh) → returned instantly, no upstream call
// Cache hit (stale) → returned instantly, 1 background refresh
const data = await shield.getOrSet(
  `resource:${id}`,
  (signal) => fetchResource(id, signal),
  {
    ttlMs: 60_000,
    staleTtlMs: 300_000,
    shouldCache: (val) => val !== null,          // don't cache null/miss results
    waitUntil: ctx.waitUntil.bind(ctx),          // required for Cloudflare Workers / Next.js App Router
  }
);
```

### Pattern 3: N+1 query elimination with BatchFlight

```typescript
import { BatchFlight } from 'flight-shield';

// Set up once (e.g. per-request context in GraphQL)
const userLoader = new BatchFlight<number, User>(
  async (ids) => db.query('SELECT * FROM users WHERE id = ANY($1)', [ids]),
  { maxBatchSize: 100, maxWindowMs: 10 }
);

// In resolvers — each call is individually awaited but batched automatically
const user = await userLoader.load(userId);
```

### Pattern 4: Stampede-safe cache invalidation

```typescript
// WRONG — causes stampede on next read burst
await cache.delete(`product:${id}`);

// RIGHT — marks stale, serves old value instantly, refreshes once in background
await shield.softPurge(`product:${id}`);
```

## TypeScript types

```typescript
// ShieldOptions — full option set for StampedeShield.getOrSet()
interface ShieldOptions<T> {
  ttlMs?: number | ((value: T) => number);  // static or dynamic TTL
  staleTtlMs?: number;
  beta?: number;                             // XFetch aggressiveness (default: 1)
  shouldCache?: (value: T) => boolean;       // skip caching based on value
  waitUntil?: (promise: Promise<unknown>) => void;  // serverless keepalive
  onBackgroundError?: (error: unknown, key: string) => void | Promise<void>;
  clone?: boolean | ((val: T) => T);
  timeoutMs?: number;
}
```

## Common mistakes to avoid

- Do NOT coalesce write operations (INSERT, UPDATE, DELETE)
- Do NOT use `cache.delete()` after mutations — use `shield.softPurge()` instead
- Do NOT omit `waitUntil` on Vercel/Cloudflare — background refreshes will be killed silently
- `BatchFlight` is process-local — for cross-service batching, use it per-request

## Package info

- **npm:** `flight-shield`
- **Version:** 3.4.0
- **License:** MIT
- **Node.js:** >= 20
- **Zero runtime dependencies**
- **GitHub:** https://github.com/mayankcodes-dev/flight-shield
