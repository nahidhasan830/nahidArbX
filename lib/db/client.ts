import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { schema } from "./schema";
import { logger } from "../shared/logger";


declare global {
  var __pgPool: Pool | undefined;
  var __sqlConnector: Connector | undefined;
}


const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set. Check .env.");
}

const instance = process.env.CLOUD_SQL_INSTANCE;


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


let _pool: Pool | null = globalThis.__pgPool ?? null;
let _initPromise: Promise<void> | null = null;

export async function ensureDbReady(): Promise<void> {
  if (_pool) return;
  if (!_initPromise) {
    _initPromise = buildPool().then(async (pool) => {
      pool.on("error", (err) => {
        logger.warn(
          "DB:Pool",
          `Idle client error (${(err as NodeJS.ErrnoException).code ?? "unknown"}): ${err.message}`,
        );
      });
      _pool = pool;
      if (process.env.NODE_ENV !== "production") {
        globalThis.__pgPool = pool;
      }

      let lastErr: Error | null = null;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const client = await pool.connect();
          await client.query("SELECT 1");
          client.release();
          logger.info("DB:Pool", "Connection verified");
          return;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          if (attempt < 5) {
            const delay = Math.min(1000 * 2 ** attempt, 10_000);
            logger.warn(
              "DB:Pool",
              `Connection attempt ${attempt}/5 failed (${lastErr.message}), retrying in ${delay}ms...`,
            );
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
      throw (
        lastErr ??
        new Error("Failed to establish DB connection after 5 attempts")
      );
    });
  }
  await _initPromise;
}


function getDb(): ReturnType<typeof drizzle> {
  if (!_pool) {
    throw new Error(
      "[DB] Pool not initialized. Ensure ensureDbReady() was awaited " +
        "in instrumentation.ts (Next.js) or engine.ts before any DB access.",
    );
  }
  return drizzle(_pool, { schema, casing: "snake_case" });
}

let _cachedDb: ReturnType<typeof drizzle> | null = null;
let _cachedPool: Pool | null = null;

function getCachedDb(): ReturnType<typeof drizzle> {
  if (_cachedDb && _cachedPool === _pool) return _cachedDb;
  _cachedDb = getDb();
  _cachedPool = _pool;
  return _cachedDb;
}

export const db: ReturnType<typeof drizzle> = new Proxy(
  {} as ReturnType<typeof drizzle>,
  {
    get(_target, prop, receiver) {
      const real = getCachedDb();
      const value = Reflect.get(real, prop, receiver);
      if (typeof value === "function") {
        return value.bind(real);
      }
      return value;
    },
  },
);

export type Db = ReturnType<typeof drizzle>;
