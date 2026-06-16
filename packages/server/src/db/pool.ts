import pg from "pg";

export function createPool(databaseUrl?: string): pg.Pool {
  const connectionString = databaseUrl ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  return new pg.Pool({ connectionString });
}
