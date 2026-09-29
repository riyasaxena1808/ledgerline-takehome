import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { createAzurePostgresConfig } from "@/lib/azure-postgres";

// A shared connection pool. Use it directly, or swap in any ORM or query
// builder you prefer (Drizzle, Prisma, Kysely...). Designing the schema is
// part of the exercise, so there are no tables yet.
const globalForDb = globalThis as unknown as { pool?: Pool };

function getDatabaseUrl() {
  const filePath = process.env.DATABASE_URL_FILE;
  if (filePath) {
    const value = readFileSync(filePath, "utf8").trim();
    if (value) return value;
  }
  return process.env.DATABASE_URL;
}

export const pool =
  globalForDb.pool ??
  new Pool(createAzurePostgresConfig() ?? { connectionString: getDatabaseUrl() });

if (process.env.NODE_ENV !== "production") globalForDb.pool = pool;
