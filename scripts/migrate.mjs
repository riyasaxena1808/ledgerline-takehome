import { Pool } from "pg";
import { DefaultAzureCredential } from "@azure/identity";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(currentDir, "../migrations");

const databaseUrl = process.env.DATABASE_URL_FILE
  ? (await readFile(process.env.DATABASE_URL_FILE, "utf8")).trim()
  : process.env.DATABASE_URL;

const azurePostgresHost = process.env.AZURE_POSTGRES_HOST;
const azurePostgresUser = process.env.AZURE_POSTGRES_USER;
if (!databaseUrl && (!azurePostgresHost || !azurePostgresUser)) {
  throw new Error("DATABASE_URL is not configured.");
}

const credential = azurePostgresHost ? new DefaultAzureCredential() : null;
const pool = new Pool(databaseUrl ? { connectionString: databaseUrl } : {
  host: azurePostgresHost,
  port: Number(process.env.AZURE_POSTGRES_PORT ?? "5432"),
  database: process.env.AZURE_POSTGRES_DATABASE ?? "ledgerline",
  user: azurePostgresUser,
  ssl: { rejectUnauthorized: true },
  password: async () => {
    const token = await credential?.getToken("https://ossrdbms-aad.database.windows.net/.default");
    if (!token) throw new Error("Could not obtain a PostgreSQL access token.");
    return token.token;
  },
});

async function migrate() {
  const client = await pool.connect();
  let locked = false;

  try {
    // Prevent two migration runners from running together.
    await client.query("SELECT pg_advisory_lock($1, $2)", [4242, 1]);
    locked = true;

    // Record which migrations have already run.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = (await readdir(migrationsDir))
      .filter((file) => /^\d+_[\w-]+\.sql$/.test(file))
      .sort();

    for (const file of files) {
      const result = await client.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [file]
      );

      if (result.rowCount > 0) {
        console.log(`Already applied: ${file}`);
        continue;
      }

      const sql = await readFile(
        path.join(migrationsDir, file),
        "utf8"
      );

      await client.query("BEGIN");

      try {
        await client.query(sql);

        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file]
        );

        await client.query("COMMIT");
        console.log(`Applied: ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    console.log("Database migrations complete.");
  } finally {
    if (locked) {
      await client.query(
        "SELECT pg_advisory_unlock($1, $2)",
        [4242, 1]
      );
    }
    client.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error("Migration failed:", error);
  process.exitCode = 1;
});
