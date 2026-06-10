import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Minimal database interface satisfied by both `pg` (production/Supabase) and PGlite (tests/local). */
export interface DB {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

export async function migrate(db: DB): Promise<string[]> {
  await db.exec(
    `create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`,
  );
  const applied = new Set(
    (await db.query<{ name: string }>(`select name from schema_migrations`)).rows.map((r) => r.name),
  );
  const ran: string[] = [];
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    await db.query(`insert into schema_migrations (name) values ($1)`, [file]);
    ran.push(file);
  }
  return ran;
}

/** In-process Postgres (PGlite) — used by the test suite and local dev without a server. */
export async function createPgliteDb(): Promise<DB> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite();
  return {
    async query<T>(text: string, params?: unknown[]) {
      const res = await pg.query(text, params as never[]);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    async close() {
      await pg.close();
    },
  };
}

/** Server Postgres via pg Pool — point DATABASE_URL at Supabase in production. */
export async function createPgDb(connectionString: string): Promise<DB> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString,
    max: 5, // serverless-friendly; use Supabase's pooled (port 6543) connection string
    connectionTimeoutMillis: 8000, // fail fast with a clear error instead of hanging a function
    ssl: /supabase\.(co|com)/.test(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  return {
    async query<T>(text: string, params?: unknown[]) {
      const res = await pool.query(text, params);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async close() {
      await pool.end();
    },
  };
}

export async function createDb(): Promise<DB> {
  const url = process.env.DATABASE_URL;
  return url ? createPgDb(url) : createPgliteDb();
}
