/**
 * Apply the NOSIH database schema over Postgres (DDL — PostgREST cannot do this).
 *
 *   node scripts/apply-schema.mjs            # fresh install: backend/supabase/schema.sql
 *   node scripts/apply-schema.mjs --migration # additive: backend/supabase/migrations/001_nosih.sql
 *
 * Reads SUPABASE_URL + SUPABASE_DB_PASSWORD from the repository-root .env.
 * The password is never printed. schema.sql / 001_nosih.sql are idempotent
 * (CREATE TABLE IF NOT EXISTS …), so re-running is safe. After applying, it
 * reloads the PostgREST schema cache so the backend sees the tables at once.
 *
 * BACK UP FIRST on a populated database (Supabase Dashboard → Database → Backups).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const require = createRequire(path.join(ROOT, "backend", "package.json"));

const dotenv = require("dotenv");
dotenv.config({ path: path.join(ROOT, ".env") });
const { Client } = require("pg");

const useMigration = process.argv.includes("--migration");
const sqlFile = useMigration
  ? path.join(ROOT, "backend", "supabase", "migrations", "001_nosih.sql")
  : path.join(ROOT, "backend", "supabase", "schema.sql");

const supabaseUrl = process.env.SUPABASE_URL;
const password = process.env.SUPABASE_DB_PASSWORD;
if (!supabaseUrl || !password) {
  console.error("FAIL: SUPABASE_URL and SUPABASE_DB_PASSWORD must be set in the root .env");
  process.exit(1);
}

const ref = new URL(supabaseUrl).hostname.split(".")[0];
const sql = fs.readFileSync(sqlFile, "utf8");

const client = new Client({
  host: `db.${ref}.supabase.co`,
  port: 5432,
  user: "postgres",
  password,
  database: "postgres",
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
});

const listTables = async () => {
  const res = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
  );
  return res.rows.map((r) => r.table_name);
};

try {
  await client.connect();
  console.log(`connected to db.${ref}.supabase.co`);
  console.log("applying:", path.relative(ROOT, sqlFile));
  console.log("tables before:", (await listTables()).join(", ") || "(none)");

  await client.query(sql);

  // Tables created over a direct Postgres connection (not the Supabase SQL
  // editor) do not inherit Supabase's automatic role grants. The backend talks
  // to PostgREST as service_role (BYPASSRLS), so grant it full DML on every
  // table/sequence/function. anon/authenticated get nothing — the browser never
  // reaches Supabase directly (RLS on, zero policies, backend-only).
  await client.query(`
    GRANT USAGE ON SCHEMA public TO service_role;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
    GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
  `);

  await client.query("NOTIFY pgrst, 'reload schema'");

  console.log("tables after:", (await listTables()).join(", "));
  await client.end();
  console.log("SCHEMA APPLIED OK");
} catch (e) {
  console.error("FAIL:", e.message);
  process.exitCode = 1;
  try { await client.end(); } catch {}
}