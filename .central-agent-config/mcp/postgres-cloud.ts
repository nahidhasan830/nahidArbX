import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

loadEnv({
  path: fileURLToPath(new URL("../../.env", import.meta.url)),
  quiet: true,
});

const querySchema = {
  sql: z.string().min(1),
};

async function main() {
  process.chdir(projectRoot);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const parsedUrl = new URL(databaseUrl);
  let connector: Connector | undefined;
  let poolPromise: Promise<Pool> | undefined;

  async function buildPool() {
    const instance = process.env.CLOUD_SQL_INSTANCE;
    if (!instance) {
      return new Pool({ connectionString: databaseUrl, max: 4 });
    }

    connector = new Connector();
    const clientOptions = await connector.getOptions({
      instanceConnectionName: instance,
      ipType: IpAddressTypes.PUBLIC,
    });

    return new Pool({
      ...clientOptions,
      user: decodeURIComponent(parsedUrl.username),
      password: decodeURIComponent(parsedUrl.password),
      database: parsedUrl.pathname.slice(1),
      max: 4,
    });
  }

  function getPool() {
    poolPromise ??= buildPool();
    return poolPromise;
  }

  const server = new McpServer(
    {
      name: "nahidarbx/postgres-cloud",
      version: "0.2.0",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    },
  );

  server.registerResource(
    "tables",
    "postgres://public/tables",
    {
      title: "Public database tables",
      mimeType: "application/json",
    },
    async (uri) => {
      const pool = await getPool();
      const client = await pool.connect();
      try {
        const result = await client.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
        );
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(result.rows, null, 2),
            },
          ],
        };
      } finally {
        client.release();
      }
    },
  );

  server.registerTool(
    "query",
    {
      title: "Read-only SQL query",
      description: "Run a read-only SQL query against the NahidArbX Postgres database",
      inputSchema: querySchema,
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ sql }) => {
      const pool = await getPool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        await client.query("SET LOCAL statement_timeout = '15000ms'");
        const result = await client.query(sql);
        await client.query("ROLLBACK");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result.rows, null, 2),
            },
          ],
          isError: false,
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      } finally {
        client.release();
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    const pool = await poolPromise?.catch(() => undefined);
    await pool?.end().catch(() => {});
    connector?.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
