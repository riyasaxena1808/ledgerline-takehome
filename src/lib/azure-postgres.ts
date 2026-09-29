import { DefaultAzureCredential } from "@azure/identity";
import type { PoolConfig } from "pg";

const postgresTokenScope = "https://ossrdbms-aad.database.windows.net/.default";

export function createAzurePostgresConfig(): PoolConfig | null {
  const host = process.env.AZURE_POSTGRES_HOST;
  if (!host) return null;
  const user = process.env.AZURE_POSTGRES_USER;
  const database = process.env.AZURE_POSTGRES_DATABASE ?? "ledgerline";
  if (!user) throw new Error("AZURE_POSTGRES_USER must name the provisioned Entra database principal.");
  const credential = new DefaultAzureCredential();
  return {
    host,
    port: Number(process.env.AZURE_POSTGRES_PORT ?? "5432"),
    database,
    user,
    ssl: { rejectUnauthorized: true },
    password: async () => {
      const token = await credential.getToken(postgresTokenScope);
      if (!token) throw new Error("Could not obtain a PostgreSQL access token.");
      return token.token;
    },
  };
}
