import fs from "node:fs";
import path from "node:path";

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), ".data");
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
const useDatabase = Boolean(databaseUrl);
const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const useSupabaseRest = Boolean(supabaseUrl && supabaseServiceKey);
let sqlPromise;
let databaseReadyPromise;

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
    const isLocalDatabase = /^(postgres(?:ql)?:\/\/)?[^@/]*@?(localhost|127\.0\.0\.1)/.test(databaseUrl);
    // Vercel runs many serverless instances concurrently, each with its own
    // copy of this module and its own connection pool — with no cap, each
    // one defaults to up to 10 real Postgres connections, so just two or
    // three warm instances can exceed a small hosted pooler's connection
    // limit (a production "max clients reached" outage traced back to
    // exactly this: no `max` here, plus a query that briefly opened three
    // connections at once). Kept low deliberately, per instance.
    sqlPromise = import("postgres").then(({ default: postgres }) => postgres(databaseUrl, {
      ssl: isLocalDatabase ? false : "require",
      max: 3,
      idle_timeout: 20
    }));
  }
  const sql = await sqlPromise;
  if (!databaseReadyPromise) {
    databaseReadyPromise = sql`CREATE TABLE IF NOT EXISTS planner_store (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  }
  await databaseReadyPromise;
  return sql;
}

function fileFor(key) {
  return path.join(dataDir, `${key}.json`);
}

export async function readStored(key, fallback) {
  if (useDatabase) {
    const sql = await database();
    const rows = await sql`SELECT value FROM planner_store WHERE key = ${key} LIMIT 1`;
    return rows[0]?.value ?? fallback;
  }
  if (useSupabaseRest) {
    const response = await supabaseRequest(key, { headers: { Prefer: "return=representation" } });
    const rows = await response.json();
    return rows[0]?.value ?? fallback;
  }
  try { return JSON.parse(fs.readFileSync(fileFor(key), "utf8")); }
  catch { return fallback; }
}

// Reads just the `id` field of every entry in a stored JSON array, without
// transferring the rest of each entry — for a key like
// planner-rollback-history, whose entries each carry a full deep-cloned
// planner snapshot, this is the difference between a multi-megabyte
// response and a tiny one. Direct Postgres does the `id` extraction
// server-side via a JSONB path query, so only the small ids array crosses
// the wire; the local-file and Supabase-REST modes have no equivalent
// shortcut and fall back to a full read, which is fine there since
// neither incurs hosted-database egress.
export async function readStoredIds(key) {
  if (useDatabase) {
    const sql = await database();
    const rows = await sql`
      SELECT jsonb_path_query_array(value, '$[*].id') AS ids
      FROM planner_store WHERE key = ${key} LIMIT 1
    `;
    return Array.isArray(rows[0]?.ids) ? rows[0].ids : [];
  }
  const full = await readStored(key, []);
  return Array.isArray(full) ? full.map(item => item?.id).filter(Boolean) : [];
}

// Read/write one field of a stored JSON document without touching the rest
// of it. Direct Postgres does this with `->` and `jsonb_set` server-side, so
// neither the read nor the write ever transfers the whole document — for a
// key like planner-data (hundreds of KB to low MB in real production data),
// that's the difference between a few dozen bytes of traffic and the whole
// document, which matters for anything called as often as every row-storage
// save (see touchTeamPresence in server.mjs). The local-file and
// Supabase-REST modes have no equivalent shortcut and fall back to a full
// read/write, which is fine there since neither incurs hosted egress.
export async function readStoredField(key, field, fallback) {
  if (useDatabase) {
    const sql = await database();
    const rows = await sql`SELECT value -> ${field}::text AS field_value FROM planner_store WHERE key = ${key} LIMIT 1`;
    return rows[0]?.field_value ?? fallback;
  }
  const full = await readStored(key, {});
  return full?.[field] ?? fallback;
}

export async function writeStoredField(key, field, value) {
  if (useDatabase) {
    const sql = await database();
    await sql`
      INSERT INTO planner_store (key, value, updated_at)
      VALUES (${key}, jsonb_build_object(${field}::text, ${sql.json(value)}), NOW())
      ON CONFLICT (key) DO UPDATE
        SET value = jsonb_set(planner_store.value, ${sql.array([field])}, ${sql.json(value)}, true),
            updated_at = NOW()
    `;
    return value;
  }
  const full = await readStored(key, {});
  full[field] = value;
  return writeStored(key, full);
}

export async function writeStored(key, value) {
  if (useDatabase) {
    const sql = await database();
    // Use sql.json() rather than `${JSON.stringify(value)}::jsonb`: the
    // postgres package's jsonb parameter handling already serializes the
    // value, so pre-stringifying it double-encodes — the column ends up
    // holding a JSON *string* scalar instead of a JSON object, and every
    // subsequent read silently returns that string instead of real data.
    await sql`INSERT INTO planner_store (key, value, updated_at)
      VALUES (${key}, ${sql.json(value)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;
    return value;
  }
  if (useSupabaseRest) {
    await supabaseRequest(key, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() })
    });
    return value;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(fileFor(key), JSON.stringify(value, null, 2));
  return value;
}

export async function deleteStored(key) {
  if (useDatabase) {
    const sql = await database();
    await sql`DELETE FROM planner_store WHERE key = ${key}`;
    return;
  }
  if (useSupabaseRest) {
    await supabaseRequest(key, { method: "DELETE" });
    return;
  }
  try { fs.unlinkSync(fileFor(key)); } catch {}
}

export function storageMode() {
  return useDatabase ? "database" : (useSupabaseRest ? "supabase-rest" : "local-files");
}

// Whether a direct Postgres connection is configured. Row-based planner
// storage (lib/planner-repository.mjs) requires this to be true; it never
// falls back to the Supabase REST or local-file paths.
export function hasDirectDatabase() {
  return useDatabase;
}

// Returns the shared `postgres` tagged-template client, lazily created and
// reused (see database() above) so callers never open a second connection.
// Throws if no direct Postgres connection is configured — callers must check
// hasDirectDatabase() first, or handle the rejection, before using this.
export async function getDatabaseClient() {
  if (!useDatabase) {
    throw new Error("Direct Postgres is not configured (DATABASE_URL/POSTGRES_URL is unset).");
  }
  return database();
}
