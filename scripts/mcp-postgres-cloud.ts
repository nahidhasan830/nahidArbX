import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import pg from "pg";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

loadEnv({
  path: fileURLToPath(new URL("../.env", import.meta.url)),
  quiet: true,
});

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const parsedUrl = new URL(databaseUrl);
  const resourceBaseUrl = new URL(databaseUrl);
  resourceBaseUrl.protocol = "postgres:";
  resourceBaseUrl.password = "";

  let connector: Connector | undefined;
  let poolPromise: Promise<pg.Pool> | undefined;

  async function buildPool() {
    const instance = process.env.CLOUD_SQL_INSTANCE;
    if (!instance) {
      return new pg.Pool({ connectionString: databaseUrl });
    }

    connector = new Connector();
    const clientOptions = await connector.getOptions({
      instanceConnectionName: instance,
      ipType: IpAddressTypes.PUBLIC,
    });

    return new pg.Pool({
      ...clientOptions,
      user: decodeURIComponent(parsedUrl.username),
      password: decodeURIComponent(parsedUrl.password),
      database: parsedUrl.pathname.slice(1),
    });
  }

  function getPool() {
    poolPromise ??= buildPool();
    return poolPromise;
  }

  const server = new Server(
    {
      name: "nahidarbx/postgres-cloud",
      version: "0.1.0",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    },
  );

  const schemaPath = "schema";

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      );
      return {
        resources: result.rows.map((row) => ({
          uri: new URL(`${row.table_name}/${schemaPath}`, resourceBaseUrl).href,
          mimeType: "application/json",
          name: `\"${row.table_name}\" database schema`,
        })),
      };
    } finally {
      client.release();
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resourceUrl = new URL(request.params.uri);
    const pathComponents = resourceUrl.pathname.split("/");
    const schema = pathComponents.pop();
    const tableName = pathComponents.pop();

    if (schema !== schemaPath) {
      throw new Error("Invalid resource URI");
    }

    const pool = await getPool();
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1",
        [tableName],
      );
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify(result.rows, null, 2),
          },
        ],
      };
    } finally {
      client.release();
    }
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "query",
        description: "Run a read-only SQL query",
        inputSchema: {
          type: "object",
          properties: {
            sql: { type: "string" },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "query") {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    const sql = request.params.arguments?.sql;
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      const result = await client.query(String(sql));
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
        isError: false,
      };
    } finally {
      client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

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
