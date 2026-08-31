import fs from "node:fs";
import path from "node:path";

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), ".data");
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
const useDatabase = Boolean(databaseUrl);
const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const useSupabaseRest = Boolean(supabaseUrl && supabaseServiceKey);
let sqlPromise;

function supabaseHeaders(extra = {}) {
  return {
    apikey: supabaseServiceKey,
    Authorization: `Bearer ${supabaseServiceKey}`,
    "Content-Type": "application/json",
    ...extra
  };
}

async function supabaseRequest(key, options = {}) {
  const query = options.method === "POST" ? "" : `?key=eq.${encodeURIComponent(key)}`;
  const response = await fetch(`${supabaseUrl}/rest/v1/planner_store${query}`, {
    ...options,
    headers: supabaseHeaders(options.headers)
  });
  if (!response.ok) throw new Error(`Supabase storage request failed (${response.status})`);
  return response;
}

async function database() {
  if (!sqlPromise) {
    sqlPromise = import("postgres").then(({ default: postgres }) => postgres(databaseUrl, { ssl: "require" }));
  }
  const sql = await sqlPromise;
  await sql`CREATE TABLE IF NOT EXISTS planner_store (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  return sql;
}

function fileFor(key) {
  return path.join(dataDir, `${key}.json`);
}

export async function readStored(key, fallback) {
  if (useSupabaseRest) {
    const response = await supabaseRequest(key, { headers: { Prefer: "return=representation" } });
    const rows = await response.json();
    return rows[0]?.value ?? fallback;
  }
  if (useDatabase) {
    const sql = await database();
    const rows = await sql`SELECT value FROM planner_store WHERE key = ${key} LIMIT 1`;
    return rows[0]?.value ?? fallback;
  }
  try { return JSON.parse(fs.readFileSync(fileFor(key), "utf8")); }
  catch { return fallback; }
}

export async function writeStored(key, value) {
  if (useSupabaseRest) {
    await supabaseRequest(key, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() })
    });
    return value;
  }
  if (useDatabase) {
    const sql = await database();
    await sql`INSERT INTO planner_store (key, value, updated_at)
      VALUES (${key}, ${JSON.stringify(value)}::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;
    return value;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(fileFor(key), JSON.stringify(value, null, 2));
  return value;
}

export async function deleteStored(key) {
  if (useSupabaseRest) {
    await supabaseRequest(key, { method: "DELETE" });
    return;
  }
  if (useDatabase) {
    const sql = await database();
    await sql`DELETE FROM planner_store WHERE key = ${key}`;
    return;
  }
  try { fs.unlinkSync(fileFor(key)); } catch {}
}

export function storageMode() {
  return useSupabaseRest ? "supabase-rest" : (useDatabase ? "database" : "local-files");
}
