import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL;
if (!url)
  throw new Error("DATABASE_URL is not set (check .env and cloud-sql-proxy).");

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  casing: "snake_case",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
