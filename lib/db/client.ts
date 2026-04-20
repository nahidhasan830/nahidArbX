import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { schema } from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
  // eslint-disable-next-line no-var
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

const pool: Pool = globalThis.__pgPool ?? (await buildPool());
if (process.env.NODE_ENV !== "production") {
  globalThis.__pgPool = pool;
}

export const db = drizzle(pool, { schema, casing: "snake_case" });
export type Db = typeof db;
