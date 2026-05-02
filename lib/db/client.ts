import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { schema } from "./schema";

// ── HMR-safe globals ──────────────────────────────────────────────────

declare global {
  var __pgPool: Pool | undefined;
  var __sqlConnector: Connector | undefined;
}

// ── Config ────────────────────────────────────────────────────────────

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set. Check .env.");
}

const instance = process.env.CLOUD_SQL_INSTANCE;

// ── Pool creation ─────────────────────────────────────────────────────

async function buildPool(): Promise<Pool> {
  if (!instance) {
    return new Pool({ connectionString: databaseUrl, max: 10 });
  }

  const url = new URL(databaseUrl!);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = url.pathname.slice(1);

  const connector = globalThis.__sqlConnector ?? new Connector();
  if (process.env.NODE_ENV !== "production") {
    globalThis.__sqlConnector = connector;
  }
  const clientOpts = await connector.getOptions({
    instanceConnectionName: instance,
    ipType: IpAddressTypes.PUBLIC,
  });
  return new Pool({ ...clientOpts, user, password, database, max: 10 });
}

// ── Initialization ────────────────────────────────────────────────────
//
// ensureDbReady() MUST be awaited before any DB access.
// Call sites:
//   1. instrumentation.ts register() — runs before any Next.js route
//   2. engine.ts — runs before any background task
//
// After init, `db` is a real Drizzle instance. No Proxy needed.

let _pool: Pool | null = globalThis.__pgPool ?? null;
let _initPromise: Promise<void> | null = null;

export async function ensureDbReady(): Promise<void> {
  if (_pool) return;
  if (!_initPromise) {
    _initPromise = buildPool().then((pool) => {
      _pool = pool;
      if (process.env.NODE_ENV !== "production") {
        globalThis.__pgPool = pool;
      }
    });
  }
  await _initPromise;
}

// ── Export: db ─────────────────────────────────────────────────────────
//
// `db` is created lazily from the pool. By the time any route handler
// or background task accesses `db`, ensureDbReady() has already been
// awaited (by instrumentation.ts or engine.ts), so `_pool` is set.
//
// We use a getter on a wrapper object to defer pool access. This avoids
// Proxy and works with Turbopack's module graph duplication because
// the getter reads from module-scope `_pool` at call time, not at
// module-load time.

function getDb(): ReturnType<typeof drizzle> {
  if (!_pool) {
    throw new Error(
      "[DB] Pool not initialized. Ensure ensureDbReady() was awaited " +
        "in instrumentation.ts (Next.js) or engine.ts before any DB access.",
    );
  }
  return drizzle(_pool, { schema, casing: "snake_case" });
}

// Cache the drizzle instance per pool to avoid re-creating on every access
let _cachedDb: ReturnType<typeof drizzle> | null = null;
let _cachedPool: Pool | null = null;

function getCachedDb(): ReturnType<typeof drizzle> {
  if (_cachedDb && _cachedPool === _pool) return _cachedDb;
  _cachedDb = getDb();
  _cachedPool = _pool;
  return _cachedDb;
}

// The export: a Proxy that delegates ALL property access to the real
// drizzle instance. Unlike the previous approach, this Proxy never
// wraps return values — it's a transparent passthrough that only
// exists to defer the `_pool` lookup from module-load time to access time.
export const db: ReturnType<typeof drizzle> = new Proxy(
  {} as ReturnType<typeof drizzle>,
  {
    get(_target, prop, receiver) {
      const real = getCachedDb();
      const value = Reflect.get(real, prop, receiver);
      // Bind methods to the real instance so `this` works correctly
      if (typeof value === "function") {
        return value.bind(real);
      }
      return value;
    },
  },
);

export type Db = ReturnType<typeof drizzle>;
