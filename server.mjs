import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { deleteStored, getDatabaseClient, hasDirectDatabase, readStored, storageMode, writeStored } from "./lib/store.mjs";
import { applyWorkflowAutomations, normalizeWorkflowAutomations } from "./lib/workflow-automations.mjs";
import { createPlannerRepository } from "./lib/planner-repository.mjs";
import { createPlannerService } from "./lib/planner-service.mjs";

// Row storage is additive and opt-in, activated in two separate stages —
// with both unset (the default), every route below behaves exactly as it
// did before Task 2, using the legacy whole-document planner_store path.
//
// Stage 1, PLANNER_ROW_STORAGE_ENABLED: turns on row READS (the change feed)
// for preview verification. Stage 2, PLANNER_ROW_WRITES_ENABLED: turns on
// row WRITES (every create/patch/delete/reorder/undo endpoint) once that
// read-side preview has been accepted. Neither flag does anything by
// itself, though: both require a completed migration whose parity report
// came back clean (checked at runtime via hasVerifiedMigrationParity(),
// not just trusted from the env var) — see getPlannerReadService() below.
const PLANNER_ROW_STORAGE_ENABLED = String(process.env.PLANNER_ROW_STORAGE_ENABLED || "").toLowerCase() === "true";
const PLANNER_ROW_WRITES_ENABLED = String(process.env.PLANNER_ROW_WRITES_ENABLED || "").toLowerCase() === "true";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const uploadsDir = path.join(publicDir, "uploads");

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const PORT = Number(process.env.PORT || 8787);
const APP_ID = process.env.INSTAGRAM_APP_ID || "";
const APP_SECRET = process.env.INSTAGRAM_APP_SECRET || "";
const REDIRECT_URI = process.env.INSTAGRAM_REDIRECT_URI || `http://localhost:${PORT}/auth/instagram/callback`;
const CANVA_CLIENT_ID = process.env.CANVA_CLIENT_ID || "";
const CANVA_CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET || "";
const CANVA_REDIRECT_URI = process.env.CANVA_REDIRECT_URI || `http://localhost:${PORT}/auth/canva/callback`;
const API_VERSION = process.env.META_API_VERSION || "v25.0";
const PLANNER_PASSWORD = process.env.PLANNER_PASSWORD || "";
const AUTH_SECRET = process.env.AUTH_SECRET || PLANNER_PASSWORD || "planner-development-secret";
const ASSET_STORAGE_LIMIT_MB = Math.max(50, Number(process.env.ASSET_STORAGE_LIMIT_MB) || 500);
const ACCOUNT_SESSION_DAYS = 14;
const ROLLBACK_HISTORY_LIMIT = 40;

const ROLE_VALUES = ["Admin", "Photographer", "Social Media Manager", "Assistant", "Editor"];
let plannerMutationQueue = Promise.resolve();
const DEFAULT_ACCOUNTS = [
  { name: "Loren", role: "Admin" },
  { name: "Brooke", role: "Admin" }
];
function publicUser(user) {
  return user ? { id: user.id, name: user.name, role: user.role } : null;
}
async function readUsers() {
  const users = await readStored("planner-users", []);
  return Array.isArray(users) ? users : [];
}
async function writeUsers(users) {
  return writeStored("planner-users", users);
}
async function seedDefaultUsers() {
  const users = DEFAULT_ACCOUNTS.map(account => ({
    id: crypto.randomUUID(),
    name: account.name,
    role: account.role,
    passwordHash: hashPassword("admin"),
    createdAt: new Date().toISOString()
  }));
  await writeUsers(users);
  return users;
}
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `scrypt$${salt}$${crypto.scryptSync(String(password), salt, 64).toString("hex")}`;
}
function passwordMatches(password, stored) {
  const [scheme, salt, digest] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !digest) return false;
  const candidate = crypto.scryptSync(String(password || ""), salt, 64).toString("hex");
  const a = Buffer.from(candidate), b = Buffer.from(digest);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function createAccountSession(userId) {
  const issued = String(Date.now());
  const payload = `${userId}.${issued}`;
  const signature = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  return `${payload}.${signature}`;
}
function userFromSession(req, users) {
  const value = readCookies(req).planner_session || "";
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [userId, issued, signature] = parts;
  if (!userId || !issued || !signature || Date.now() - Number(issued) > 1000 * 60 * 60 * 24 * ACCOUNT_SESSION_DAYS) return null;
  const payload = `${userId}.${issued}`;
  const expected = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return users.find(user => user.id === userId) || null;
}
function setAccountCookie(res, userId) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `planner_session=${encodeURIComponent(createAccountSession(userId))}; HttpOnly; SameSite=Lax; Path=/${secure}; Max-Age=${ACCOUNT_SESSION_DAYS * 86400}`);
}
function clearAccountCookie(res) {
  res.setHeader("Set-Cookie", "planner_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

let environmentSessionSeeded = false;
async function readSession() {
  await seedEnvironmentSession();
  return readStored("instagram-session", {});
}
async function writeSession(value) {
  return writeStored("instagram-session", value);
}
async function readCanvaSession(userId) { return readStored(`canva-session-${userId}`, {}); }
async function writeCanvaSession(userId, value) { return writeStored(`canva-session-${userId}`, value); }
async function seedEnvironmentSession() {
  if (environmentSessionSeeded || !process.env.INSTAGRAM_ACCESS_TOKEN) return;
  const existing = await readStored("instagram-session", {});
  if (!existing.access_token && !existing.disabled) {
    await writeSession({
      access_token: process.env.INSTAGRAM_ACCESS_TOKEN,
      source: "environment",
      stored_at: new Date().toISOString()
    });
  }
  environmentSessionSeeded = true;
}

function sendJson(res, status, data) {
  res.writeHead(status, {"Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"});
  res.end(JSON.stringify(data));
}
function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 45 * 1024 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error("Invalid JSON body.")); }
    });
    req.on("error", reject);
  });
}
function readCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const i = part.indexOf("=");
    return [i < 0 ? part : part.slice(0, i), i < 0 ? "" : decodeURIComponent(part.slice(i + 1))];
  }));
}
function isAuthenticated(req) {
  if (!PLANNER_PASSWORD) return true;
  const value = readCookies(req).planner_auth || "";
  const [issued, signature] = value.split(".");
  if (!issued || !signature || Date.now() - Number(issued) > 1000 * 60 * 60 * 24 * 14) return false;
  const expected = crypto.createHmac("sha256", AUTH_SECRET).update(issued).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function setAuthCookie(res, token) {
  const issued = String(Date.now());
  const signature = crypto.createHmac("sha256", AUTH_SECRET).update(issued).digest("hex");
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `planner_auth=${encodeURIComponent(`${issued}.${signature}`)}; HttpOnly; SameSite=Lax; Path=/${secure}; Max-Age=1209600`);
}
function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", "planner_auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}
function passwordsMatch(candidate) {
  const a = Buffer.from(String(candidate || ""));
  const b = Buffer.from(PLANNER_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function createOAuthState() {
  const payload = `${Date.now()}.${crypto.randomBytes(24).toString("hex")}`;
  const signature = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  return `${payload}.${signature}`;
}
async function createCanvaOAuthState(userId) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const nonce = crypto.randomBytes(24).toString("base64url");
  const payload = `${Date.now()}.${nonce}`;
  const signature = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  await writeStored(`canva-oauth-state-${nonce}`, { userId, verifier, createdAt: Date.now() });
  return { state: `${payload}.${signature}`, challenge };
}
async function parseCanvaOAuthState(state) {
  const [issued, nonce, signature] = String(state || "").split(".");
  if (!issued || !nonce || !signature || Date.now() - Number(issued) > 1000 * 60 * 10) return null;
  const payload = `${issued}.${nonce}`;
  const expected = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const record = await readStored(`canva-oauth-state-${nonce}`, null);
  await deleteStored(`canva-oauth-state-${nonce}`);
  return record && Date.now() - Number(record.createdAt || 0) <= 1000 * 60 * 10 ? record : null;
}
function isValidOAuthState(state) {
  const [issued, nonce, signature] = String(state || "").split(".");
  if (!issued || !nonce || !signature || Date.now() - Number(issued) > 1000 * 60 * 10) return false;
  const payload = `${issued}.${nonce}`;
  const expected = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function canvaDesignId(value) {
  const match = String(value || "").match(/\/(?:design|api\/design)\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}
export async function waitForCanvaExport(job, token, { maxAttempts = 60, intervalMs = 1000 } = {}) {
  const jobId = job?.job?.id || job?.id;
  let result = job?.job || job;
  if (!jobId) throw new Error("Canva did not return an export job ID.");

  for (let attempt = 0; attempt < maxAttempts && result?.status !== "success"; attempt++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    const response = await fetchJson(`https://api.canva.com/rest/v1/exports/${jobId}`, { headers: { Authorization: `Bearer ${token}` } });
    result = response?.job || response;
  }
  return result;
}
async function canvaExportFormats(designId, token) {
  return fetchJson(`https://api.canva.com/rest/v1/designs/${encodeURIComponent(designId)}/export-formats`, {
    headers: { Authorization: `Bearer ${token}` }
  });
}
export function canvaContentType({ pageCount, designTypes = [], doctypeName = "", formats = {} }) {
  if (Number(pageCount) > 1) return "carousel";
  const isVideo = designTypes.some(type => /video|reel|movie/i.test(String(type))) || /\bvideo\b/i.test(doctypeName);
  return isVideo && formats?.mp4 ? "video" : "image";
}
export async function preferredCanvaExportType(designId, token) {
  const formats = await canvaExportFormats(designId, token);
  return formats?.formats?.mp4 ? "mp4" : "jpg";
}
export function canvaExportUrls(result) {
  const urls = result?.urls || result?.result?.urls || [];
  return Array.isArray(urls) ? urls.filter(Boolean) : [];
}
async function saveCanvaExport(url, formatType) {
  if (!url) throw new Error(`Canva did not return a ${formatType} export yet.`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Canva ${formatType} download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = formatType === "mp4" ? "video/mp4" : "image/jpeg";
  const filename = `${crypto.randomUUID()}.${formatType}`;
  const blob = await blobClient();
  if (blob) {
    const saved = await blob.put(`planner/${filename}`, bytes, { access: "public", contentType, addRandomSuffix: false });
    return saved.url;
  }
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, filename), bytes);
  return `/uploads/${filename}`;
}
async function exportCanvaFiles(designId, token, formatType) {
  const job = await fetchJson("https://api.canva.com/rest/v1/exports", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ design_id: designId, format: { type: formatType, ...(formatType === "jpg" ? { quality: 90 } : {}), ...(formatType === "mp4" ? { quality: "vertical_1080p" } : {}) } })
  });
  const result = await waitForCanvaExport(job, token);
  const urls = canvaExportUrls(result);
  if (!urls.length) throw new Error(`Canva did not return a ${formatType} export yet.`);
  return Promise.all(urls.map(url => saveCanvaExport(url, formatType)));
}
async function exportCanvaFile(designId, token, formatType) {
  return (await exportCanvaFiles(designId, token, formatType))[0];
}
async function exportCanvaPreview(designId, token) {
  return (await exportCanvaFiles(designId, token, "jpg"))[0];
}
async function canvaTokenRequest(form) {
  const auth = Buffer.from(`${CANVA_CLIENT_ID}:${CANVA_CLIENT_SECRET}`).toString("base64");
  return fetchJson("https://api.canva.com/rest/v1/oauth/token", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });
}
async function canvaAccessToken(userId) {
  const session = await readCanvaSession(userId);
  if (!session.access_token) return null;
  if (session.expires_in && session.token_received_at && Date.now() < Number(session.token_received_at) + Number(session.expires_in) * 1000 - 60_000) return session.access_token;
  if (!session.refresh_token) return session.access_token;
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refresh_token });
  const refreshed = await canvaTokenRequest(form);
  await writeCanvaSession(userId, { ...session, ...refreshed, token_received_at: Date.now(), refreshed_at: new Date().toISOString() });
  return refreshed.access_token;
}
function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    ".html":"text/html; charset=utf-8",
    ".css":"text/css; charset=utf-8",
    ".js":"text/javascript; charset=utf-8",
    ".svg":"image/svg+xml",
    ".png":"image/png",
    ".jpg":"image/jpeg",
    ".jpeg":"image/jpeg",
    ".webp":"image/webp",
    ".ico":"image/x-icon"
    ,".mp4":"video/mp4"
    ,".mov":"video/quicktime"
    ,".webm":"video/webm"
  })[ext] || "application/octet-stream";
}
async function fetchJson(url, options={}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {raw:text}; }
  if (!response.ok || data?.error) {
    const service = url.includes("api.canva.com") ? "Canva" : "Instagram";
    const message = data?.error?.message || data?.message || data?.error_description || `${service} request failed (${response.status})`;
    const err = new Error(message);
    err.details = data;
    throw err;
  }
  return data;
}
async function getInstagramProfile(token) {
  const fields = "user_id,username,account_type,media_count";
  const url = new URL(`https://graph.instagram.com/${API_VERSION}/me`);
  url.searchParams.set("fields", fields);
  url.searchParams.set("access_token", token);
  return fetchJson(url);
}
async function getInstagramMedia(token, limit = null) {
  const all = [];
  let url = new URL(`https://graph.instagram.com/${API_VERSION}/me/media`);
  url.searchParams.set("fields", "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp");
  url.searchParams.set("limit", "100");
  url.searchParams.set("access_token", token);

  for (let page = 0; page < 50 && url; page++) {
    const result = await fetchJson(url);
    all.push(...(result.data || []));
    const next = result.paging?.next;
    url = next ? new URL(next) : null;
  }
  if (limit !== null && limit !== undefined) {
    return all.slice(0, Math.min(100, Math.max(3, Number(limit) || 12)));
  }
  return all;
}
async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    client_id: APP_ID,
    client_secret: APP_SECRET,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
    code
  });
  const short = await fetchJson("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body
  });

  const longUrl = new URL("https://graph.instagram.com/access_token");
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", APP_SECRET);
  longUrl.searchParams.set("access_token", short.access_token);
  const long = await fetchJson(longUrl);

  return {
    access_token: long.access_token || short.access_token,
    user_id: short.user_id || null,
    expires_in: long.expires_in || null,
    stored_at: new Date().toISOString(),
    source: "oauth"
  };
}
async function refreshLongLivedToken(session) {
  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", session.access_token);
  const refreshed = await fetchJson(url);
  const next = {
    ...session,
    access_token: refreshed.access_token || session.access_token,
    expires_in: refreshed.expires_in || session.expires_in,
    stored_at: new Date().toISOString(),
    source: "refreshed"
  };
  await writeSession(next);
  return next;
}
async function blobClient() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  return import("@vercel/blob");
}
async function blobUsage() {
  const client = await blobClient();
  if (!client) return { configured: false, usedBytes: 0, limitBytes: ASSET_STORAGE_LIMIT_MB * 1024 * 1024 };
  let cursor;
  let usedBytes = 0;
  do {
    const page = await client.list({ prefix: "planner/", ...(cursor ? { cursor } : {}) });
    usedBytes += (page.blobs || []).reduce((total, blob) => total + Number(blob.size || 0), 0);
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);
  return { configured: true, usedBytes, limitBytes: ASSET_STORAGE_LIMIT_MB * 1024 * 1024 };
}
async function deleteBlobUrl(url) {
  if (!url || !url.includes(".blob.vercel-storage.com")) return;
  try {
    const client = await blobClient();
    if (client) await client.del(url);
  } catch (error) {
    console.error("Blob cleanup failed:", error.message);
  }
}

function publicInstagramStatus(session, extra = {}) {
  return {
    connected: Boolean(session?.access_token),
    configured: Boolean(APP_ID && APP_SECRET),
    shared: true,
    connected_at: session?.stored_at || null,
    last_synced_at: session?.last_synced_at || null,
    ...extra
  };
}

function normalizeComment(comment) {
  return {
    author: String(comment?.author || "Team").slice(0, 80),
    role: String(comment?.role || "").slice(0, 40),
    text: String(comment?.text || "").slice(0, 4000),
    at: comment?.at || new Date().toISOString()
  };
}

export const ASSET_EDITABLE_FIELDS = new Set([
  "type", "workflow", "status", "approval", "assignee", "priority", "pillar",
  "date", "scheduleState", "caption", "notes", "audio", "hashtags", "tagNotes",
  "altText", "location", "locationTag", "cropZoom", "cropX", "cropY",
  "comments", "coverImage", "image", "images", "assetKind", "canvaAssetType", "canvaPreviewUpdatedAt"
]);

function sanitizeFieldMap(map, sanitizeVal) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return {};
  const out = {};
  for (const field of ASSET_EDITABLE_FIELDS) {
    if (Object.hasOwn(map, field)) {
      const cleaned = sanitizeVal(map[field]);
      if (cleaned !== undefined) out[field] = cleaned;
    }
  }
  return out;
}

export function normalizePost(post) {
  const workflowValues = ["idea", "drafting", "needs-assets", "needs-caption", "needs-review", "feedback", "approved", "ready-meta", "meta-scheduled", "published", "archived"];
  const workflow = workflowValues.includes(post?.workflow)
    ? post.workflow
    : post?.status === "posted"
      ? "published"
      : post?.approval === "needs-review"
        ? "needs-review"
        : post?.approval === "feedback"
          ? "feedback"
        : post?.approval === "approved"
          ? "approved"
          : post?.status === "draft" ? "drafting" : "idea";
  const images = Array.isArray(post?.images) ? post.images.map(image => String(image || "").slice(0, 2000)).filter(Boolean).slice(0, 100) : [];
  const image = String(post?.image || images[0] || "").slice(0, 2000);
  const revision = Math.max(1, Number(post?.revision) || 1);
  const fieldUpdatedRevision = sanitizeFieldMap(post?.fieldUpdatedRevision, v => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  });
  const fieldUpdatedAt = sanitizeFieldMap(post?.fieldUpdatedAt, v => (v ? String(v) : undefined));
  const fieldUpdatedBy = sanitizeFieldMap(post?.fieldUpdatedBy, v => (v ? String(v).slice(0, 80) : undefined));

  return {
    id: String(post?.id || crypto.randomUUID()),
    metaId: post?.metaId ? String(post.metaId) : "",
    image,
    images: images.length ? images : (image ? [image] : []),
    coverImage: String(post?.coverImage || ""),
    canvaUrl: String(post?.canvaUrl || "").slice(0, 2000),
    canvaDesignId: String(post?.canvaDesignId || "").slice(0, 200),
    canvaDesignTypes: Array.isArray(post?.canvaDesignTypes) ? post.canvaDesignTypes.map(type => String(type).slice(0, 40)).slice(0, 8) : [],
    canvaDoctypeName: String(post?.canvaDoctypeName || "").slice(0, 120),
    canvaAssetType: post?.canvaAssetType === "video" ? "video" : post?.canvaAssetType === "image" ? "image" : "",
    canvaPageCount: Math.max(0, Math.min(500, Number(post?.canvaPageCount) || 0)),
    canvaPreviewUpdatedAt: String(post?.canvaPreviewUpdatedAt || ""),
    assetKind: post?.assetKind === "video" ? "video" : "image",
    cropRatio: ["1:1", "4:5", "1.91:1", "9:16"].includes(post?.cropRatio) ? post.cropRatio : "4:5",
    cropZoom: Math.min(3, Math.max(1, Number(post?.cropZoom) || 1)),
    cropX: post?.cropX == null ? 50 : (Number.isFinite(Number(post.cropX)) ? Math.min(100, Math.max(0, Number(post.cropX))) : 50),
    cropY: post?.cropY == null ? 50 : (Number.isFinite(Number(post.cropY)) ? Math.min(100, Math.max(0, Number(post.cropY))) : 50),
    status: post?.status === "posted" ? "posted" : (post?.status === "draft" ? "draft" : "planned"),
    approval: ["needs-review", "feedback", "approved"].includes(post?.approval) ? post.approval : "feedback",
    type: String(post?.type || "IMAGE").trim().toUpperCase().slice(0, 30) || "IMAGE",
    date: String(post?.date || ""),
    time: String(post?.time || ""),
    scheduleState: ["draft", "ready", "scheduled"].includes(post?.scheduleState) ? post.scheduleState : "draft",
    workflow,
    assignee: String(post?.assignee || "").slice(0, 80),
    dueDate: String(post?.dueDate || "").slice(0, 10),
    priority: ["low", "normal", "high"].includes(post?.priority) ? post.priority : "normal",
    pillar: String(post?.pillar || "").slice(0, 80),
    goal: String(post?.goal || "").slice(0, 300),
    audience: String(post?.audience || "").slice(0, 300),
    hook: String(post?.hook || "").slice(0, 500),
    cta: String(post?.cta || "").slice(0, 300),
    hashtags: String(post?.hashtags || "").slice(0, 1000),
    audio: String(post?.audio || "").slice(0, 300),
    altText: String(post?.altText || "").slice(0, 500),
    location: String(post?.location || "").slice(0, 120),
    tags: Array.isArray(post?.tags) ? [...new Set(post.tags.map(tag => String(tag).trim().replace(/^#/, "")).filter(Boolean))].slice(0, 20) : [],
    locationTag: post?.locationTag && typeof post.locationTag === "object" ? {
      name: String(post.locationTag.name || "").slice(0, 120),
      latitude: Number.isFinite(Number(post.locationTag.latitude)) ? Math.max(-90, Math.min(90, Number(post.locationTag.latitude))) : null,
      longitude: Number.isFinite(Number(post.locationTag.longitude)) ? Math.max(-180, Math.min(180, Number(post.locationTag.longitude))) : null,
      source: ["metadata", "manual"].includes(post.locationTag.source) ? post.locationTag.source : "manual"
    } : null,
    client: String(post?.client || "").slice(0, 120),
    tagNotes: String(post?.tagNotes || "").slice(0, 500),
    checklist: Array.isArray(post?.checklist) ? post.checklist.slice(0, 20).map(item => ({
      label: String(item?.label || "").slice(0, 120),
      done: Boolean(item?.done)
    })).filter(item => item.label) : [],
    caption: String(post?.caption || ""),
    notes: String(post?.notes || ""),
    comments: Array.isArray(post?.comments) ? post.comments.map(normalizeComment) : [],
    timestamp: String(post?.timestamp || ""),
    permalink: String(post?.permalink || ""),
    revision,
    fieldUpdatedRevision,
    fieldUpdatedAt,
    fieldUpdatedBy,
    updatedBy: String(post?.updatedBy || ""),
    updatedAt: post?.updatedAt || new Date().toISOString()
  };
}

export function normalizeAssetChanges(changes = {}) {
  const candidate = normalizePost({ id: "candidate", image: "/placeholder.jpg", ...changes });
  return Object.fromEntries([...ASSET_EDITABLE_FIELDS]
    .filter(field => Object.hasOwn(changes, field))
    .map(field => [field, candidate[field]]));
}

export function applyAssetChanges(post, changes = {}, actor = {}, now = new Date().toISOString()) {
  const normalizedChanges = normalizeAssetChanges(changes);
  const normalizedPost = normalizePost(post);
  const changedFields = Object.keys(normalizedChanges);
  if (!changedFields.length) return normalizedPost;

  const nextRevision = normalizedPost.revision + 1;
  const nextFieldUpdatedRevision = { ...normalizedPost.fieldUpdatedRevision };
  const nextFieldUpdatedAt = { ...normalizedPost.fieldUpdatedAt };
  const nextFieldUpdatedBy = { ...normalizedPost.fieldUpdatedBy };
  const actorName = String(actor?.name || "").slice(0, 80);

  for (const field of changedFields) {
    nextFieldUpdatedRevision[field] = nextRevision;
    nextFieldUpdatedAt[field] = now;
    if (actorName) {
      nextFieldUpdatedBy[field] = actorName;
    } else {
      delete nextFieldUpdatedBy[field];
    }
  }

  if (Object.hasOwn(normalizedChanges, "comments")) {
    const commentKeys = new Set(normalizedPost.comments.map(comment => JSON.stringify(comment)));
    normalizedChanges.comments = [...normalizedPost.comments, ...normalizedChanges.comments.filter(comment => {
      const key = JSON.stringify(comment);
      if (commentKeys.has(key)) return false;
      commentKeys.add(key);
      return true;
    })];
  }

  return normalizePost({
    ...normalizedPost,
    ...normalizedChanges,
    revision: nextRevision,
    fieldUpdatedRevision: nextFieldUpdatedRevision,
    fieldUpdatedAt: nextFieldUpdatedAt,
    fieldUpdatedBy: nextFieldUpdatedBy,
    updatedBy: actorName || normalizedPost.updatedBy,
    updatedAt: now
  });
}

export function assetConflicts(post, submittedRevision, changes = {}) {
  const normalizedChanges = normalizeAssetChanges(changes);
  const normalizedPost = normalizePost(post);
  const subRev = Number(submittedRevision) || 1;
  const conflicts = {};

  for (const field of Object.keys(normalizedChanges)) {
    if (field === "comments") continue;
    const fieldRev = normalizedPost.fieldUpdatedRevision[field] || 1;
    if (fieldRev > subRev) {
      conflicts[field] = {
        currentValue: normalizedPost[field],
        updatedBy: normalizedPost.fieldUpdatedBy[field] || normalizedPost.updatedBy || "",
        updatedAt: normalizedPost.fieldUpdatedAt[field] || normalizedPost.updatedAt || ""
      };
    }
  }

  return conflicts;
}
export function normalizeScratchEntry(entry) {
  const status = entry?.status === "archived" ? "archived" : "active";
  const rawImage = String(entry?.image || "").slice(0, 2000);
  const images = Array.isArray(entry?.images)
    ? entry.images.map(img => String(img).trim().slice(0, 2000)).filter(Boolean).slice(0, 20)
    : (rawImage ? [rawImage] : []);
  const primaryImage = images[0] || rawImage;
  return {
    id: String(entry?.id || crypto.randomUUID()),
    title: String(entry?.title || "").slice(0, 160),
    body: String(entry?.body || "").slice(0, 6000),
    image: primaryImage,
    images: images.length ? images : (primaryImage ? [primaryImage] : []),
    format: String(entry?.format || "").slice(0, 40),
    pillar: String(entry?.pillar || "").slice(0, 80),
    goal: String(entry?.goal || "").slice(0, 240),
    hook: String(entry?.hook || "").slice(0, 300),
    cta: String(entry?.cta || "").slice(0, 240),
    tags: Array.isArray(entry?.tags) ? [...new Set(entry.tags.map(tag => String(tag).trim().replace(/^#/, "")).filter(Boolean))].slice(0, 20) : [],
    comments: Array.isArray(entry?.comments) ? entry.comments.map(normalizeComment) : [],
    status,
    createdBy: String(entry?.createdBy || "").slice(0, 80),
    updatedBy: String(entry?.updatedBy || "").slice(0, 80),
    createdAt: String(entry?.createdAt || new Date().toISOString()),
    updatedAt: String(entry?.updatedAt || new Date().toISOString())
  };
}

function defaultPlanner() {
  return { version: 0, posts: [], scratch: [], team: [], activity: [], settings: defaultSettings(), updatedAt: null };
}
function defaultSettings() {
  return {
    pillars: ["Newborn education", "Family sessions", "Motherhood", "Behind the scenes", "Client stories", "Photographer education", "Personal connection", "Offers and availability"],
    formats: ["IMAGE", "REEL", "CAROUSEL"],
    goals: ["Educate", "Connect", "Showcase work", "Book sessions", "Build trust"],
    syncPhotoCount: 12,
    workflowAutomations: normalizeWorkflowAutomations()
  };
}
export function normalizeSettings(settings) {
  const base = defaultSettings();
  return {
    pillars: Array.isArray(settings?.pillars) && settings.pillars.length ? settings.pillars.map(item => String(item).trim()).filter(Boolean).slice(0, 40) : base.pillars,
    formats: Array.isArray(settings?.formats) && settings.formats.length ? settings.formats.map(item => String(item).trim().toUpperCase()).filter(Boolean).slice(0, 20) : base.formats,
    goals: Array.isArray(settings?.goals) && settings.goals.length ? settings.goals.map(item => String(item).trim()).filter(Boolean).slice(0, 30) : base.goals,
    syncPhotoCount: Math.min(100, Math.max(3, Number(settings?.syncPhotoCount) || base.syncPhotoCount)),
    workflowAutomations: normalizeWorkflowAutomations(settings?.workflowAutomations)
  };
}

function normalizeActivityText(text) {
  return String(text || "")
    .replace(/a\s+Scratch\s+Book\s+idea/gi, "an idea")
    .replace(/Scratch\s+Book\s+idea/gi, "idea")
    .replace(/saved\s+to\s+Scratch\s+Book/gi, "saved an idea")
    .replace(/Scratch\s+Book/gi, "idea")
    .replace(/\b(?:a|an)\s+(?:idea\s+idea|Idea\s+idea)\b/gi, "an idea")
    .replace(/\ba\s+idea\b/gi, "an idea")
    .slice(0, 180);
}

async function readPlanner() {
  const planner = await readStored("planner-data", defaultPlanner());
  return {
    version: Number(planner?.version || 0),
    posts: Array.isArray(planner?.posts) ? planner.posts.map(normalizePost) : [],
    scratch: Array.isArray(planner?.scratch) ? planner.scratch.map(normalizeScratchEntry).slice(0, 500) : [],
    team: Array.isArray(planner?.team) ? planner.team : [],
    activity: Array.isArray(planner?.activity) ? planner.activity.map(item => ({ ...item, text: normalizeActivityText(item?.text) })).slice(0, 40) : [],
    settings: normalizeSettings(planner?.settings),
    updatedAt: planner?.updatedAt || null
  };
}

function upsertTeamMember(planner, actor = {}) {
  if (!actor?.name) return;
  const name = String(actor.name).slice(0, 80);
  const role = String(actor.role || "Admin").slice(0, 40);
  const existing = planner.team.find(member => member.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.role = role;
    existing.lastSeenAt = new Date().toISOString();
    return;
  }
  planner.team.unshift({ name, role, lastSeenAt: new Date().toISOString() });
  planner.team = planner.team.slice(0, 12);
}

function addActivity(planner, text) {
  if (!text) return;
  const activity = {
    id: crypto.randomUUID(),
    text: normalizeActivityText(text),
    at: new Date().toISOString(),
    reversible: false,
    rollbackId: null
  };
  planner.activity.unshift(activity);
  planner.activity = planner.activity.slice(0, 40);
  return activity;
}

function addReversibleActivity(planner, text) {
  const activity = addActivity(planner, text);
  if (activity) {
    activity.reversible = true;
    activity.rollbackId = activity.id;
  }
  return activity;
}

async function withPlannerMutation(fn) {
  const previous = plannerMutationQueue;
  let release;
  plannerMutationQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function plannerSnapshot(planner) {
  return JSON.parse(JSON.stringify({
    posts: planner.posts,
    scratch: planner.scratch,
    team: planner.team,
    settings: planner.settings
  }));
}

async function readRollbackHistory() {
  const history = await readStored("planner-rollback-history", []);
  return Array.isArray(history) ? history.slice(0, ROLLBACK_HISTORY_LIMIT) : [];
}

async function writeRollbackHistory(history) {
  return writeStored("planner-rollback-history", history.slice(0, ROLLBACK_HISTORY_LIMIT));
}

async function saveRollbackSnapshot(snapshot, activity, restoreVersion, restoreUpdatedAt) {
  if (!snapshot || !activity?.rollbackId) return;
  const history = await readRollbackHistory();
  history.unshift({
    id: activity.rollbackId,
    activityId: activity.id,
    snapshot,
    restoreVersion,
    restoreUpdatedAt,
    createdAt: activity.at
  });
  await writeRollbackHistory(history);
}

async function writePlanner(nextPlanner, { incrementVersion = true, rollbackSnapshot = null, rollbackActivity = null } = {}) {
  const normalized = {
    version: Number(nextPlanner?.version || 0) + (incrementVersion ? 1 : 0),
    posts: Array.isArray(nextPlanner?.posts) ? nextPlanner.posts.map(normalizePost) : [],
    scratch: Array.isArray(nextPlanner?.scratch) ? nextPlanner.scratch.map(normalizeScratchEntry).slice(0, 500) : [],
    team: Array.isArray(nextPlanner?.team) ? nextPlanner.team : [],
    activity: Array.isArray(nextPlanner?.activity) ? nextPlanner.activity.map(item => ({ ...item, text: normalizeActivityText(item?.text) })).slice(0, 40) : [],
    settings: normalizeSettings(nextPlanner?.settings),
    updatedAt: new Date().toISOString()
  };
  const saved = await writeStored("planner-data", normalized);
  if (rollbackSnapshot && rollbackActivity) await saveRollbackSnapshot(rollbackSnapshot, rollbackActivity, saved.version, saved.updatedAt);
  return saved;
}
function mergeInstagramPosts(planner, media, actorName = "Instagram sync") {
  const byMeta = new Map(planner.posts.filter(post => post.metaId).map(post => [post.metaId, post]));
  for (const item of media) {
    const image = item.thumbnail_url || item.media_url;
    if (!image) continue;
    const normalized = normalizePost({
      id: byMeta.get(item.id)?.id || crypto.randomUUID(),
      metaId: item.id,
      image,
      status: "posted",
      approval: "approved",
      type: item.media_type || "IMAGE",
      date: (item.timestamp || "").slice(0, 10),
      time: item.timestamp ? new Date(item.timestamp).toISOString().slice(11, 16) : "",
      scheduleState: "scheduled",
      caption: item.caption || "",
      notes: "Synced from Instagram",
      comments: byMeta.get(item.id)?.comments || [],
      timestamp: item.timestamp || "",
      permalink: item.permalink || "",
      updatedBy: actorName,
      updatedAt: new Date().toISOString()
    });
    const existing = byMeta.get(item.id);
    if (existing) Object.assign(existing, normalized);
    else planner.posts.push(normalized);
  }
}

let plannerRepositoryPromise;

// Lazily builds the row-storage repository the first time it's needed.
// Returns null when direct Postgres isn't configured — the repository
// requires a real Postgres client and never falls back to the Supabase
// REST/local-file paths used by the legacy planner_store document.
async function getPlannerRepository() {
  if (!hasDirectDatabase()) return null;
  if (!plannerRepositoryPromise) {
    plannerRepositoryPromise = getDatabaseClient()
      .then(async sql => {
        const repository = createPlannerRepository({ sql });
        await repository.ensureSchema();
        return repository;
      })
      .catch(error => {
        // Don't cache a failed connection attempt forever — let the next
        // health check retry instead of permanently reporting unavailable.
        plannerRepositoryPromise = undefined;
        throw error;
      });
  }
  return plannerRepositoryPromise;
}

// Returns null when row storage isn't enabled/configured/verified, so
// callers can fall back to the legacy whole-document path without a
// special case for "flag off" vs "Postgres unavailable" vs "migration not
// yet reviewed" — all of those just mean "no service." The flag alone is
// deliberately not trusted: hasVerifiedMigrationParity() re-checks against
// planner_migrations on every call, so someone flipping the env var before
// running (or after a failed) migration can't accidentally serve reads
// from row tables that don't yet match the legacy document.
async function getPlannerReadService() {
  if (!PLANNER_ROW_STORAGE_ENABLED) return null;
  const repository = await getPlannerRepository();
  if (!repository) return null;
  if (!(await repository.hasVerifiedMigrationParity())) return null;
  return createPlannerService({ repository });
}

// Writes are a second, separate activation stage: PLANNER_ROW_WRITES_ENABLED
// only takes effect once the read-side service above is already active
// (verified migration parity included), matching "enable writes only after
// row-read parity is accepted."
async function getPlannerWriteService() {
  if (!PLANNER_ROW_WRITES_ENABLED) return null;
  return getPlannerReadService();
}

// Task 10 observability: a safe operation log for judging whether row
// storage is ready to have its legacy fallback retired. Deliberately
// carries only these four fields — never captions, media URLs,
// credentials, cookies, request bodies, or passwords, none of which this
// function ever receives in the first place, so there's nothing to
// accidentally include no matter what a caller passes as `operation`.
export function buildPlannerDiagnostic({ operation, startedAt, outcome }) {
  return {
    operation: String(operation || "").slice(0, 80),
    durationMs: Date.now() - startedAt,
    outcome: String(outcome || "").slice(0, 40),
    flags: { rowStorageEnabled: PLANNER_ROW_STORAGE_ENABLED, rowWritesEnabled: PLANNER_ROW_WRITES_ENABLED }
  };
}

function logPlannerDiagnostic(entry) {
  console.log(JSON.stringify({ plannerDiagnostic: entry }));
}

// Times one row-storage operation and logs its outcome. `fn` returns
// either a plain result (outcome "ok") or a `{ error }` shape (outcome is
// that error string) — the same convention every planner-service method
// already uses, so call sites don't need to compute outcome themselves.
async function withPlannerDiagnostics(operation, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    logPlannerDiagnostic(buildPlannerDiagnostic({ operation, startedAt, outcome: result?.error || "ok" }));
    return result;
  } catch (error) {
    logPlannerDiagnostic(buildPlannerDiagnostic({ operation, startedAt, outcome: "exception" }));
    throw error;
  }
}

// Never throws: an unreachable/misconfigured Postgres is reported as
// rowSchemaReady: false (a safe service-unavailable signal), not a 500.
async function plannerRowSchemaHealth() {
  try {
    const repository = await getPlannerRepository();
    if (!repository) return { rowSchemaReady: false };
    const result = await repository.health();
    return { rowSchemaReady: result?.rowSchemaReady };
  } catch {
    return { rowSchemaReady: false };
  }
}

export async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    // Vercel rewrites requests to the single API function. Preserve the
    // original application path so /auth/* and /api/* routes remain distinct.
    const routedPath = url.searchParams.get("__path");
    if (routedPath) {
      url.pathname = routedPath.startsWith("/") ? routedPath : `/${routedPath}`;
      url.searchParams.delete("__path");
    }
    let users = await readUsers();
    if (!users.length) users = await seedDefaultUsers();
    const account = userFromSession(req, users);

    if (url.pathname === "/auth/login" && req.method === "POST") {
      const body = await readBody(req);
      const login = String(body.login || body.name || "").trim().toLowerCase();
      let user = users.find(item => item.name.toLowerCase() === login);
      let valid = user && passwordMatches(body.password, user.passwordHash);
      // Keep existing deployments working: the old shared password can create
      // the first Loren account, after which all sign-ins use named accounts.
      if (!user && !users.length && PLANNER_PASSWORD && passwordsMatch(body.password) && (!login || login === "loren")) {
        user = { id: crypto.randomUUID(), name: "Loren", role: "Admin", passwordHash: hashPassword(body.password), createdAt: new Date().toISOString() };
        await writeUsers([user]);
        valid = true;
      }
      if (!valid) {
        return sendJson(res, 401, {error: "That name or password didn’t match."});
      }
      setAccountCookie(res, user.id);
      return sendJson(res, 200, {ok:true, user: publicUser(user)});
    }
    if (url.pathname === "/auth/register") return sendJson(res, 404, {error: "Account creation is disabled."});
    if (url.pathname === "/auth/logout" && req.method === "POST") {
      clearAccountCookie(res);
      return sendJson(res, 200, {ok:true});
    }
    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      return sendJson(res, account ? 200 : 401, account ? { user: publicUser(account) } : { error: "Please sign in to the planner." });
    }
    if (url.pathname === "/api/auth/profile" && req.method === "PUT") {
      if (!account) return sendJson(res, 401, {error: "Please sign in to the planner."});
      const body = await readBody(req);
      const name = String(body.name || "").trim().slice(0, 80);
      const role = ROLE_VALUES.includes(body.role) ? body.role : account.role;
      const password = String(body.password || "");
      if (name.length < 2) return sendJson(res, 400, {error: "Enter a display name."});
      if (password && password.length < 8) return sendJson(res, 400, {error: "New passwords must have at least 8 characters."});
      if (users.some(item => item.id !== account.id && item.name.toLowerCase() === name.toLowerCase())) return sendJson(res, 409, {error: "That display name is already in use."});
      account.name = name;
      account.role = role;
      if (password) account.passwordHash = hashPassword(password);
      await writeUsers(users);
      return sendJson(res, 200, {user: publicUser(account)});
    }

    if (url.pathname === "/api/team/members" && req.method === "GET") {
      if (!account) return sendJson(res, 401, { error: "Please sign in to the planner." });
      return sendJson(res, 200, { members: users.map(publicUser) });
    }

    if (url.pathname === "/api/team/members" && req.method === "POST") {
      if (!account) return sendJson(res, 401, { error: "Please sign in to the planner." });
      const body = await readBody(req);
      const name = String(body.name || "").trim().slice(0, 80);
      const role = ROLE_VALUES.includes(body.role) ? body.role : "Admin";
      const password = String(body.password || "");
      if (name.length < 2) return sendJson(res, 400, { error: "Enter a display name with at least 2 characters." });
      if (!password || password.length < 8) return sendJson(res, 400, { error: "Password must have at least 8 characters." });
      if (users.some(item => item.name.toLowerCase() === name.toLowerCase())) {
        return sendJson(res, 409, { error: "A team member with that name already exists." });
      }
      const newUser = {
        id: crypto.randomUUID(),
        name,
        role,
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString()
      };
      users.push(newUser);
      await writeUsers(users);

      const planner = await readPlanner();
      upsertTeamMember(planner, newUser);
      const rollbackSnapshot = plannerSnapshot(planner);
      const rollbackActivity = addReversibleActivity(planner, `${account.name} added ${name} (${role}) to the team`);
      await writePlanner(planner, { rollbackSnapshot, rollbackActivity });

      return sendJson(res, 201, { ok: true, member: publicUser(newUser) });
    }

    if (url.pathname.startsWith("/api/team/members/") && req.method === "PUT") {
      if (!account) return sendJson(res, 401, { error: "Please sign in to the planner." });
      const memberId = url.pathname.slice("/api/team/members/".length);
      const targetUser = users.find(item => item.id === memberId);
      if (!targetUser) return sendJson(res, 404, { error: "Team member not found." });

      const body = await readBody(req);
      const name = String(body.name || "").trim().slice(0, 80);
      const role = ROLE_VALUES.includes(body.role) ? body.role : targetUser.role;
      const password = String(body.password || "");

      if (name.length < 2) return sendJson(res, 400, { error: "Enter a display name with at least 2 characters." });
      if (password && password.length < 8) return sendJson(res, 400, { error: "New password must have at least 8 characters." });
      if (users.some(item => item.id !== memberId && item.name.toLowerCase() === name.toLowerCase())) {
        return sendJson(res, 409, { error: "That display name is already in use by another team member." });
      }

      const oldName = targetUser.name;
      const planner = await readPlanner();
      const rollbackSnapshot = plannerSnapshot(planner);
      targetUser.name = name;
      targetUser.role = role;
      if (password) targetUser.passwordHash = hashPassword(password);
      await writeUsers(users);

      const existingTeamIdx = planner.team.findIndex(m => m.name.toLowerCase() === oldName.toLowerCase());
      if (existingTeamIdx >= 0) {
        planner.team[existingTeamIdx] = { name, role, lastSeenAt: planner.team[existingTeamIdx].lastSeenAt || new Date().toISOString() };
      } else {
        upsertTeamMember(planner, targetUser);
      }
      const rollbackActivity = addReversibleActivity(planner, `${account.name} updated team member ${name}`);
      await writePlanner(planner, { rollbackSnapshot, rollbackActivity });

      return sendJson(res, 200, { ok: true, member: publicUser(targetUser) });
    }

    if (url.pathname.startsWith("/api/team/members/") && req.method === "DELETE") {
      if (!account) return sendJson(res, 401, { error: "Please sign in to the planner." });
      const memberId = url.pathname.slice("/api/team/members/".length);
      const targetUser = users.find(item => item.id === memberId);
      if (!targetUser) return sendJson(res, 404, { error: "Team member not found." });

      if (targetUser.id === account.id) {
        return sendJson(res, 400, { error: "You cannot remove your own active account from settings." });
      }
      const adminCount = users.filter(item => item.role === "Admin").length;
      if (targetUser.role === "Admin" && adminCount <= 1) {
        return sendJson(res, 400, { error: "Cannot remove the last remaining Admin account." });
      }

      const planner = await readPlanner();
      const rollbackSnapshot = plannerSnapshot(planner);
      users = users.filter(item => item.id !== memberId);
      await writeUsers(users);

      planner.team = planner.team.filter(m => m.name.toLowerCase() !== targetUser.name.toLowerCase());
      const rollbackActivity = addReversibleActivity(planner, `${account.name} removed ${targetUser.name} from the team`);
      await writePlanner(planner, { rollbackSnapshot, rollbackActivity });

      return sendJson(res, 200, { ok: true, memberId });
    }
    if (!account) {
      if (url.pathname.startsWith("/api/")) return sendJson(res, 401, {error: "Please sign in to the planner."});
      if (url.pathname !== "/login.html" && url.pathname !== "/login.js" && url.pathname !== "/auth/login") return redirect(res, "/login.html");
    }

    if (url.pathname === "/api/health/storage" && req.method === "GET") {
      if (!account) return sendJson(res, 401, { error: "Please sign in to the planner." });
      const { rowSchemaReady } = await plannerRowSchemaHealth();
      return sendJson(res, 200, { plannerStorage: storageMode(), rowSchemaReady });
    }

    if (url.pathname === "/api/admin/planner-row-migration" && req.method === "POST") {
      if (!account) return sendJson(res, 401, { error: "Please sign in to the planner." });
      if (account.role !== "Admin") return sendJson(res, 403, { error: "Only an Admin can run the planner row migration." });
      const body = await readBody(req);
      if (body.mode !== "shadow") return sendJson(res, 400, { error: "Only mode \"shadow\" is supported." });
      const repository = await getPlannerRepository();
      if (!repository) return sendJson(res, 503, { error: "Direct Postgres row storage is not configured in this environment." });
      const legacyPlanner = await readPlanner();
      const migration = await repository.migrateLegacyPlanner(legacyPlanner);
      const parity = await repository.compareLegacyPlanner(legacyPlanner);
      await repository.recordMigrationParity(migration.checksum, parity.ok);
      // Shadow mode only reports parity — it never flips PLANNER_ROW_STORAGE_ENABLED
      // or PLANNER_ROW_WRITES_ENABLED; that activation step is Task 9.
      return sendJson(res, 200, { migration, parity });
    }

    if (url.pathname === "/api/planner" && req.method === "GET") {
      const planner = await readPlanner();
      const rollbackHistory = await readRollbackHistory();
      planner.activity = planner.activity.map(item => ({
        ...item,
        reversible: Boolean(item.reversible && rollbackHistory.some(record => record.id === item.rollbackId))
      }));
      // Once row storage is serving reads, it's the source of truth for
      // everything ordinary saves touch (assets/ideas/settings) — the
      // legacy document stops being written to the moment row storage
      // writes activate, so without this it would keep serving whatever
      // the planner looked like at migration time forever, no matter how
      // many reorders/edits/creates happened since (only ever patched over
      // live, in-memory, by that one browser tab's own delta poll — gone
      // on the next reload). Instagram-synced ("posted") content is the
      // one exception: /api/instagram/sync only ever writes the legacy
      // document, never row storage, so it's kept from there — everything
      // else comes from row storage.
      const plannerService = await getPlannerReadService();
      if (plannerService) {
        const snapshot = await plannerService.readSnapshot();
        const legacyPosted = planner.posts.filter(post => post.status === "posted");
        const legacyPostedIds = new Set(legacyPosted.map(post => post.id));
        planner.posts = [...snapshot.posts.filter(post => !legacyPostedIds.has(post.id)).map(normalizePost), ...legacyPosted];
        planner.scratch = snapshot.scratch.map(normalizeScratchEntry);
        if (snapshot.settings) planner.settings = snapshot.settings;
      }
      return sendJson(res, 200, planner);
    }

    if (url.pathname === "/api/planner/changes" && req.method === "GET") {
      if (!account) return sendJson(res, 401, { error: "Please sign in to the planner." });
      const plannerService = await getPlannerReadService();
      if (!plannerService) return sendJson(res, 503, { error: "Row storage is not enabled in this environment." });
      const since = Number(url.searchParams.get("since")) || 0;
      const startedAt = Date.now();
      const latest = await plannerService.latestChangeToken();
      if (since >= latest) {
        logPlannerDiagnostic(buildPlannerDiagnostic({ operation: "planner.changes", startedAt, outcome: "not-modified" }));
        res.setHeader("ETag", `"seq-${latest}"`);
        res.writeHead(304);
        return res.end();
      }
      const { changes, nextToken } = await plannerService.changesSince(since);
      logPlannerDiagnostic(buildPlannerDiagnostic({ operation: "planner.changes", startedAt, outcome: "ok" }));
      res.setHeader("ETag", `"seq-${nextToken}"`);
      return sendJson(res, 200, { changes, nextToken });
    }

    // Once row storage is active, ordinary saves record activity into
    // planner_activity (see recordActivity in lib/planner-service.mjs)
    // instead of the legacy whole-document's `activity` array, which stops
    // being written to at that point (see PUT /api/planner above) — so the
    // Team Activity tab has to read from here instead once row storage is
    // serving reads, or every row-storage save would look like it never
    // happened in that tab.
    if (url.pathname === "/api/planner/activity" && req.method === "GET") {
      if (!account) return sendJson(res, 401, { error: "Please sign in to the planner." });
      const plannerService = await getPlannerReadService();
      if (!plannerService) return sendJson(res, 503, { error: "Row storage is not enabled in this environment." });
      const startedAt = Date.now();
      const activity = await plannerService.recentActivity();
      logPlannerDiagnostic(buildPlannerDiagnostic({ operation: "planner.activity", startedAt, outcome: "ok" }));
      return sendJson(res, 200, { activity });
    }

    if (url.pathname.startsWith("/api/planner/rollback/") && req.method === "POST") {
      if (!account) return sendJson(res, 401, { error: "Please sign in to the planner." });
      const activityId = decodeURIComponent(url.pathname.slice("/api/planner/rollback/".length));
      const body = await readBody(req);
      const planner = await readPlanner();
      const history = await readRollbackHistory();
      const record = history.find(item => item.id === activityId);
      if (!record) return sendJson(res, 404, { error: "That activity can no longer be undone." });
      if (Number(body.version) !== planner.version || Number(record.restoreVersion) !== planner.version || (record.restoreUpdatedAt && record.restoreUpdatedAt !== planner.updatedAt)) {
        return sendJson(res, 409, { error: "This activity is no longer the latest planner change. Refresh to review the latest activity.", planner });
      }
      const original = planner.activity.find(item => item.id === record.activityId);
      const restored = {
        ...planner,
        ...record.snapshot,
        activity: planner.activity
      };
      const rollbackActivity = addActivity(restored, `${account.name} undid “${original?.text || "a recent activity"}”`);
      const saved = await writePlanner(restored);
      await writeRollbackHistory(history.filter(item => item.id !== activityId));
      return sendJson(res, 200, { ok: true, planner: saved, activity: rollbackActivity });
    }

    if (url.pathname === "/api/planner/bootstrap" && req.method === "POST") {
      const body = await readBody(req);
      const planner = await readPlanner();
      if (!planner.posts.length && Array.isArray(body.seedPosts) && body.seedPosts.length) {
        const rollbackSnapshot = plannerSnapshot(planner);
        planner.posts = body.seedPosts.map(normalizePost);
        upsertTeamMember(planner, body.actor);
        const rollbackActivity = addReversibleActivity(planner, `${body?.actor?.name || "Team"} started the shared planner`);
        return sendJson(res, 200, await writePlanner(planner, { rollbackSnapshot, rollbackActivity }));
      }
      if (body?.actor?.name) {
        upsertTeamMember(planner, body.actor);
        return sendJson(res, 200, await writePlanner(planner));
      }
      return sendJson(res, 200, planner);
    }

    if (url.pathname === "/api/planner" && req.method === "PUT") {
      const body = await readBody(req);
      // Once row writes are active, this whole-document save is retired
      // from normal UI flows — every route above it now saves one row at a
      // time. It still exists for an explicit, authenticated administrator
      // import (adminImport: true), never for an ordinary client save.
      if ((await getPlannerWriteService()) && !(account?.role === "Admin" && body.adminImport === true)) {
        return sendJson(res, 403, { error: "Whole-planner saves are disabled. This planner now saves each change individually." });
      }
      const planner = await readPlanner();
      if (Number.isFinite(Number(body.version)) && Number(body.version) !== planner.version) {
        return sendJson(res, 409, { error: "This planner changed in another browser. Refresh to review the latest version before saving.", planner });
      }
      const rollbackSnapshot = plannerSnapshot(planner);
      const previousUrls = new Set(planner.posts.map(post => post.image).filter(Boolean));
      planner.posts = Array.isArray(body.posts) ? body.posts.map(post => normalizePost({ ...post, updatedBy: body?.actor?.name || post.updatedBy })) : planner.posts;
      planner.scratch = Array.isArray(body.scratch) ? body.scratch.map(entry => normalizeScratchEntry({ ...entry, updatedBy: body?.actor?.name || entry.updatedBy })) : planner.scratch;
      const nextUrls = new Set(planner.posts.map(post => post.image).filter(Boolean));
      await Promise.all([...previousUrls].filter(url => !nextUrls.has(url)).map(deleteBlobUrl));
      planner.settings = normalizeSettings(body.settings || planner.settings);
      const automationChanges = applyWorkflowAutomations(planner, planner.settings.workflowAutomations);
      upsertTeamMember(planner, body.actor);
      const rollbackActivity = body.reason ? addReversibleActivity(planner, `${body?.actor?.name || "Team"} ${body.reason}`) : null;
      if (automationChanges) addActivity(planner, `${body?.actor?.name || "Team"} automatically assigned ${automationChanges} workflow ${automationChanges === 1 ? "task" : "tasks"}`);
      return sendJson(res, 200, await writePlanner(planner, { rollbackSnapshot: rollbackActivity ? rollbackSnapshot : null, rollbackActivity }));
    }

    if (url.pathname === "/api/instagram/status") {
      const session = await readSession();
      console.log("Instagram status session present:", Boolean(session.access_token));
      if (!session.access_token) {
        return sendJson(res, 200, publicInstagramStatus(session, {redirect_uri: REDIRECT_URI}));
      }
      try {
        const profile = await getInstagramProfile(session.access_token);
        return sendJson(res, 200, publicInstagramStatus(session, {profile}));
      } catch (e) {
        console.error("Instagram profile lookup failed:", e.message);
        return sendJson(res, 200, publicInstagramStatus(session, {connected:true, error:e.message}));
      }
    }

    if (url.pathname === "/api/canva/status" && req.method === "GET") {
      const session = await readCanvaSession(account.id);
      return sendJson(res, 200, { configured: Boolean(CANVA_CLIENT_ID && CANVA_CLIENT_SECRET), connected: Boolean(session.access_token), last_synced_at: session.last_synced_at || null });
    }

    if (url.pathname === "/api/canva/preview" && req.method === "POST") {
      const body = await readBody(req);
      const designId = String(body.designId || canvaDesignId(body.canvaUrl) || "").slice(0, 200);
      if (!designId) return sendJson(res, 400, { error: "Paste a Canva design link (the link should contain /design/...)." });
      const token = await canvaAccessToken(account.id);
      if (!token) return sendJson(res, 503, { error: "Connect Canva in Settings before refreshing previews." });
      const available = await canvaExportFormats(designId, token);
      const contentType = canvaContentType({
        pageCount: body.pageCount,
        designTypes: Array.isArray(body.designTypes) ? body.designTypes : [],
        doctypeName: body.doctypeName,
        formats: available.formats
      });
      const formatType = contentType === "video" ? "mp4" : "jpg";
      const mediaType = contentType === "video" ? "video" : "image";
      const exported = contentType === "carousel"
        ? await exportCanvaFiles(designId, token, "jpg")
        : [await exportCanvaFile(designId, token, formatType)];
      const previewUrl = exported[0];
      const session = await readCanvaSession(account.id);
      await writeCanvaSession(account.id, { ...session, last_synced_at: new Date().toISOString() });
      return sendJson(res, 200, { previewUrl, images: contentType === "carousel" ? exported : undefined, mediaType, contentType });
    }

    if (url.pathname === "/api/canva/video" && req.method === "POST") {
      const body = await readBody(req);
      const designId = String(body.designId || "").slice(0, 200);
      if (!designId) return sendJson(res, 400, { error: "A Canva design ID is required." });
      const token = await canvaAccessToken(account.id);
      if (!token) return sendJson(res, 503, { error: "Connect Canva in Settings before importing videos." });
      const videoUrl = await exportCanvaFile(designId, token, "mp4");
      return sendJson(res, 200, { videoUrl });
    }

    if (url.pathname === "/api/canva/designs" && req.method === "GET") {
      const token = await canvaAccessToken(account.id);
      if (!token) return sendJson(res, 503, { error: "Connect Canva in Settings before browsing designs." });
      const params = new URLSearchParams({ limit: "50", sort_by: "modified_descending", ownership: "any" });
      const query = url.searchParams.get("query");
      if (query) params.set("query", query.slice(0, 255));
      const data = await fetchJson(`https://api.canva.com/rest/v1/designs?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      return sendJson(res, 200, { designs: (data.items || []).map(design => ({ id: design.id, title: design.title || "Untitled design", updatedAt: design.updated_at || null, thumbnail: design.thumbnail?.url || "", editUrl: design.urls?.edit_url || "", viewUrl: design.urls?.view_url || "", doctypeName: design.doctype_name || "", designTypes: Array.isArray(design.design_types) ? design.design_types : [], pageCount: design.page_count || 0 })), continuation: data.continuation || null });
    }

    if (url.pathname === "/api/instagram/media") {
      const session = await readSession();
      if (!session.access_token) return sendJson(res, 401, {error:"Instagram is not connected yet."});
      const [profile, media] = await Promise.all([
        getInstagramProfile(session.access_token),
        getInstagramMedia(session.access_token)
      ]);
      return sendJson(res, 200, {profile, media});
    }

    if (url.pathname === "/api/instagram/sync" && req.method === "POST") {
      const session = await readSession();
      console.log("Instagram sync session present:", Boolean(session.access_token));
      if (!session.access_token) return sendJson(res, 401, {error:"Instagram is not connected yet."});
      const body = await readBody(req);
      const planner = await readPlanner();
      const rollbackSnapshot = plannerSnapshot(planner);
      const [profile, media] = await Promise.all([
        getInstagramProfile(session.access_token),
        getInstagramMedia(session.access_token)
      ]);
      upsertTeamMember(planner, body.actor);
      mergeInstagramPosts(planner, media, body?.actor?.name || "Instagram sync");
      addActivity(planner, `${body?.actor?.name || "Team"} synced Instagram`);
      const saved = await writePlanner(planner);
      await writeSession({...session, last_synced_at: new Date().toISOString()});
      return sendJson(res, 200, { profile, mediaCount: media.length, planner: saved });
    }

    if (url.pathname.startsWith("/api/assets/") && req.method === "PATCH") {
      const body = await readBody(req);
      const assetId = url.pathname.split("/").pop();
      const plannerService = await getPlannerWriteService();
      if (plannerService) {
        const result = await withPlannerDiagnostics("asset.patch", () => plannerService.patchAsset({
          id: assetId, revision: body.revision, changes: body.changes,
          forceFields: Array.isArray(body.forceFields) ? body.forceFields : [],
          actor: body.actor || account, reason: body.reason
        }));
        if (result.error === "not-found") return sendJson(res, 404, { error: "This asset was removed by a teammate." });
        if (result.error === "no-changes") return sendJson(res, 400, { error: "Choose at least one asset field to update." });
        if (result.error === "conflict") return sendJson(res, 409, { error: "This asset changed while you were editing it.", code: "ASSET_FIELD_CONFLICT", asset: result.asset, conflicts: result.conflicts });
        return sendJson(res, 200, { asset: result.asset, merged: result.merged });
      }
      return withPlannerMutation(async () => {
        const planner = await readPlanner();
        const post = planner.posts.find(item => item.id === assetId);
        if (!post) return sendJson(res, 404, { error: "This asset was removed by a teammate." });
        const changes = normalizeAssetChanges(body.changes);
        if (!Object.keys(changes).length) return sendJson(res, 400, { error: "Choose at least one asset field to update." });
        const submittedRevision = Number(body.revision) || 1;
        const conflicts = assetConflicts(post, submittedRevision, changes);
        const forceFields = Array.isArray(body.forceFields) ? body.forceFields : [];
        const unforcedConflicts = Object.keys(conflicts).filter(field => !forceFields.includes(field));
        if (unforcedConflicts.length > 0) {
          return sendJson(res, 409, { error: "This asset changed while you were editing it.", code: "ASSET_FIELD_CONFLICT", asset: post, conflicts });
        }
        const updatedPost = applyAssetChanges(post, changes, body.actor || account, new Date().toISOString());
        const postIndex = planner.posts.findIndex(item => item.id === post.id);
        planner.posts[postIndex] = updatedPost;
        upsertTeamMember(planner, body.actor || account);
        addActivity(planner, body.reason ? `${body?.actor?.name || account?.name || "Team"} ${body.reason}` : `${body?.actor?.name || account?.name || "Team"} updated planned content`);
        await writePlanner(planner, { incrementVersion: false });
        return sendJson(res, 200, { asset: updatedPost, merged: submittedRevision !== post.revision });
      });
    }

    if (url.pathname === "/api/planner/assets" && req.method === "POST") {
      if (!account) return sendJson(res, 401, { error: "Please sign in to the planner." });
      const plannerService = await getPlannerWriteService();
      if (!plannerService) return sendJson(res, 503, { error: "Row storage is not enabled in this environment." });
      const body = await readBody(req);
      if (!body?.asset || typeof body.asset !== "object") return sendJson(res, 400, { error: "An asset payload is required." });
      const result = await withPlannerDiagnostics("asset.create", () => plannerService.createAsset({ asset: body.asset, actor: body.actor || account, reason: body.reason }));
      if (result.error === "id-in-use") return sendJson(res, 409, { error: "An asset with that id already exists." });
      return sendJson(res, 201, { asset: result.asset });
    }

    if (url.pathname.startsWith("/api/assets/") && req.method === "DELETE") {
      if (!account) return sendJson(res, 401, { error: "Please sign in to the planner." });
      const plannerService = await getPlannerWriteService();
      if (!plannerService) return sendJson(res, 503, { error: "Row storage is not enabled in this environment." });
      const assetId = url.pathname.slice("/api/assets/".length);
      const body = await readBody(req);
      const result = await withPlannerDiagnostics("asset.delete", () => plannerService.deleteAsset({ id: assetId, actor: body.actor || account, reason: body.reason }));
      if (result.error === "not-found") return sendJson(res, 404, { error: "This asset was already removed." });
      return sendJson(res, 200, { ok: true, id: result.id });
    }

    if (url.pathname.startsWith("/api/assets/") && url.pathname.endsWith("/reorder") && req.method === "POST") {
      if (!account) return sendJson(res, 401, { error: "Please sign in to the planner." });
      const plannerService = await getPlannerWriteService();
      if (!plannerService) return sendJson(res, 503, { error: "Row storage is not enabled in this environment." });
      const assetId = url.pathname.split("/")[3];
      const body = await readBody(req);
      const result = await withPlannerDiagnostics("asset.reorder", () => plannerService.reorderAsset({
        id: assetId, beforeId: body.beforeId || null, afterId: body.afterId || null, actor: body.actor || account
      }));
      if (result.error === "not-found") return sendJson(res, 404, { error: "This asset was removed by a teammate." });
      if (result.error === "neighbor-not-found") return sendJson(res, 409, { error: "The grid changed while you were dragging. Refresh to see the latest order." });
      return sendJson(res, 200, { asset: result.asset, affected: result.affected, changeToken: result.changeToken });
    }

    if (url.pathname === "/api/ideas" && req.method === "POST") {
      if (!account) return sendJson(res, 401, { error: "Please sign in to the planner." });
      const plannerService = await getPlannerWriteService();
      if (!plannerService) return sendJson(res, 503, { error: "Row storage is not enabled in this environment." });
      const body = await readBody(req);
      if (!body?.idea || typeof body.idea !== "object") return sendJson(res, 400, { error: "An idea payload is required." });
      const result = await withPlannerDiagnostics("idea.create", () => plannerService.createIdea({ idea: body.idea, actor: body.actor || account, reason: body.reason }));
      return sendJson(res, 201, { idea: result.idea, revision: result.revision });
    }

    if (url.pathname.startsWith("/api/ideas/") && req.method === "PATCH") {
      if (!account) return sendJson(res, 401, { error: "Please sign in to the planner." });
      const plannerService = await getPlannerWriteService();
      if (!plannerService) return sendJson(res, 503, { error: "Row storage is not enabled in this environment." });
      const ideaId = url.pathname.slice("/api/ideas/".length);
      const body = await readBody(req);
      const result = await withPlannerDiagnostics("idea.patch", () => plannerService.patchIdea({ id: ideaId, revision: body.revision, changes: body.changes || {}, actor: body.actor || account, reason: body.reason }));
      if (result.error === "not-found") return sendJson(res, 404, { error: "This idea was removed by a teammate." });
      if (result.error === "conflict") return sendJson(res, 409, { error: "This idea changed while you were editing it.", code: "IDEA_CONFLICT", idea: result.idea, revision: result.revision });
      return sendJson(res, 200, { idea: result.idea, revision: result.revision });
    }

    if (url.pathname.startsWith("/api/ideas/") && req.method === "DELETE") {
      if (!account) return sendJson(res, 401, { error: "Please sign in to the planner." });
      const plannerService = await getPlannerWriteService();
      if (!plannerService) return sendJson(res, 503, { error: "Row storage is not enabled in this environment." });
      const ideaId = url.pathname.slice("/api/ideas/".length);
      const body = await readBody(req);
      const result = await withPlannerDiagnostics("idea.delete", () => plannerService.deleteIdea({ id: ideaId, actor: body.actor || account, reason: body.reason }));
      if (result.error === "not-found") return sendJson(res, 404, { error: "This idea was already removed." });
      return sendJson(res, 200, { ok: true, id: result.id });
    }

    if (url.pathname === "/api/settings" && req.method === "PATCH") {
      if (!account) return sendJson(res, 401, { error: "Please sign in to the planner." });
      const plannerService = await getPlannerWriteService();
      if (!plannerService) return sendJson(res, 503, { error: "Row storage is not enabled in this environment." });
      const body = await readBody(req);
      const result = await withPlannerDiagnostics("settings.patch", () => plannerService.patchSettings({ revision: body.revision, changes: body.changes || {}, actor: body.actor || account }));
      if (result.error === "conflict") return sendJson(res, 409, { error: "Settings changed in another browser.", code: "SETTINGS_CONFLICT", settings: result.settings, revision: result.revision });
      return sendJson(res, 200, { settings: result.settings, revision: result.revision });
    }

    if (url.pathname.startsWith("/api/activity/") && url.pathname.endsWith("/undo") && req.method === "POST") {
      if (!account) return sendJson(res, 401, { error: "Please sign in to the planner." });
      const plannerService = await getPlannerWriteService();
      if (!plannerService) return sendJson(res, 503, { error: "Row storage is not enabled in this environment." });
      const activityId = url.pathname.split("/")[3];
      const result = await withPlannerDiagnostics("activity.undo", () => plannerService.undoActivity({ id: activityId, actor: account }));
      if (result.error === "not-found") return sendJson(res, 404, { error: "That activity could no longer be found." });
      if (result.error === "not-reversible") return sendJson(res, 400, { error: "This activity can no longer be undone.", code: "UNDO_NOT_REVERSIBLE" });
      if (result.error === "stale") return sendJson(res, 409, { error: "This item changed after that action and can no longer be safely undone.", code: "UNDO_STALE" });
      return sendJson(res, 200, result);
    }

    if (url.pathname === "/api/assets" && req.method === "POST") {
      const body = await readBody(req);
      const match = String(body?.data || "").match(/^data:([^;]+);base64,(.+)$/s);
      if (!match) return sendJson(res, 400, { error: "Please choose a valid image or video file." });
      const mime = match[1].toLowerCase();
      if (!mime.startsWith("image/") && !mime.startsWith("video/")) return sendJson(res, 400, { error: "Only images and reels are supported." });
      const bytes = Buffer.from(match[2], "base64");
      if (bytes.length > 30 * 1024 * 1024) return sendJson(res, 413, { error: "Assets must be 30 MB or smaller." });
      const ext = mime === "video/quicktime" ? "mov" : (mime.split("/")[1] || "bin").replace(/[^a-z0-9]/g, "");
      const filename = `${crypto.randomUUID()}.${ext}`;
      const blob = await blobClient();
      if (process.env.VERCEL && !blob) {
        return sendJson(res, 503, { error: "Vercel Blob is not connected to this production environment. Add BLOB_READ_WRITE_TOKEN under Production environment variables, then redeploy." });
      }
      if (blob) {
        const usage = await blobUsage();
        if (usage.usedBytes + bytes.length > usage.limitBytes) {
          return sendJson(res, 413, { error: `Storage limit reached. ${Math.max(0, usage.limitBytes - usage.usedBytes)} bytes remain.` });
        }
        const saved = await blob.put(`planner/${filename}`, bytes, { access: "public", contentType: mime, addRandomSuffix: false });
        return sendJson(res, 201, { url: saved.url, kind: mime.startsWith("video/") ? "video" : "image", storage: "blob" });
      }
      try {
        fs.mkdirSync(uploadsDir, { recursive: true });
        fs.writeFileSync(path.join(uploadsDir, filename), bytes);
        return sendJson(res, 201, { url: `/uploads/${filename}`, kind: mime.startsWith("video/") ? "video" : "image", storage: "server" });
      } catch (error) {
        if (!["EROFS", "EACCES", "ENOENT"].includes(error.code)) throw error;
        return sendJson(res, 201, { url: body.data, kind: mime.startsWith("video/") ? "video" : "image", storage: "planner" });
      }
    }

    if (url.pathname === "/api/storage/usage" && req.method === "GET") {
      const usage = await blobUsage();
      return sendJson(res, 200, {
        ...usage,
        plannerStorage: storageMode(),
        usedPercent: usage.limitBytes ? Math.min(100, Math.round(usage.usedBytes / usage.limitBytes * 100)) : 0
      });
    }

    if (url.pathname === "/api/instagram/refresh" && req.method === "POST") {
      const session = await readSession();
      if (!session.access_token) return sendJson(res, 401, {error:"Instagram is not connected yet."});
      const refreshed = await refreshLongLivedToken(session);
      return sendJson(res, 200, {ok:true, stored_at:refreshed.stored_at});
    }

    if (url.pathname === "/api/instagram/disconnect" && req.method === "POST") {
      await writeSession({ disabled: true, disconnected_at: new Date().toISOString() });
      return sendJson(res, 200, {ok:true});
    }

    if (url.pathname === "/auth/instagram") {
      if (!APP_ID || !APP_SECRET) return redirect(res, "/?meta=config");
      const state = createOAuthState();
      const auth = new URL("https://www.instagram.com/oauth/authorize");
      auth.searchParams.set("client_id", APP_ID);
      auth.searchParams.set("redirect_uri", REDIRECT_URI);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("scope", "instagram_business_basic");
      auth.searchParams.set("state", state);
      return redirect(res, auth.toString());
    }

    if (url.pathname === "/auth/canva") {
      if (!CANVA_CLIENT_ID || !CANVA_CLIENT_SECRET) return redirect(res, "/?canva=not-configured");
      const { state, challenge } = await createCanvaOAuthState(account.id);
      const auth = new URL("https://www.canva.com/api/oauth/authorize");
      auth.searchParams.set("client_id", CANVA_CLIENT_ID);
      auth.searchParams.set("redirect_uri", CANVA_REDIRECT_URI);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("scope", "design:content:read design:meta:read");
      auth.searchParams.set("code_challenge", challenge);
      auth.searchParams.set("code_challenge_method", "s256");
      auth.searchParams.set("state", state);
      return redirect(res, auth.toString());
    }

    if (url.pathname === "/auth/canva/callback") {
      const code = url.searchParams.get("code");
      const oauthState = await parseCanvaOAuthState(url.searchParams.get("state"));
      const error = url.searchParams.get("error_description") || url.searchParams.get("error");
      if (error) return redirect(res, `/?canva=error&message=${encodeURIComponent(error)}`);
      if (!code || !oauthState || !account || oauthState.userId !== account.id) return redirect(res, "/?canva=error&message=Canva%20authorization%20expired");
      try {
        const form = new URLSearchParams({ code_verifier: oauthState.verifier, grant_type: "authorization_code", redirect_uri: CANVA_REDIRECT_URI, code });
        const session = await canvaTokenRequest(form);
        await writeCanvaSession(account.id, { ...session, token_received_at: Date.now(), stored_at: new Date().toISOString(), source: "oauth" });
        return redirect(res, "/?canva=connected");
      } catch (e) {
        return redirect(res, `/?canva=error&message=${encodeURIComponent(`Canva connection failed: ${e.message}`)}`);
      }
    }

    if (url.pathname === "/auth/instagram/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error_description") || url.searchParams.get("error");
      if (error) return redirect(res, `/?meta=error&message=${encodeURIComponent(error)}`);
      if (!code) return redirect(res, "/?meta=error&message=No%20authorization%20code%20returned");
      if (!isValidOAuthState(state)) {
        console.error("Instagram OAuth callback rejected: invalid or expired state");
        return redirect(res, "/?meta=error&message=OAuth%20state%20did%20not%20match");
      }
      try {
        const session = await exchangeCodeForToken(code);
        await writeSession(session);
        console.log("Instagram OAuth callback completed and session was saved");
        return redirect(res, "/?meta=connected");
      } catch (e) {
        console.error("Instagram OAuth callback token exchange failed:", e.message);
        return redirect(res, `/?meta=error&message=${encodeURIComponent(`Instagram connection failed: ${e.message}`)}`);
      }
    }

    let requested = decodeURIComponent(url.pathname);
    if (requested === "/") requested = "/index.html";
    const safe = path.normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
    const file = path.join(publicDir, safe);
    if (!file.startsWith(publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, {"Content-Type":"text/plain; charset=utf-8"});
      return res.end("Not found");
    }
    res.writeHead(200, {"Content-Type":contentType(file)});
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    sendJson(res, 500, {error:e.message || "Server error"});
  }
}

export default handleRequest;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, async () => {
    await seedEnvironmentSession();
    console.log(`\nLoren Bullard Content Planner`);
    console.log(`Open: http://localhost:${PORT}`);
    console.log(APP_ID && APP_SECRET ? "Meta app credentials: configured" : "Meta app credentials: not configured yet");
    console.log(`Storage: ${storageMode()}`);
    console.log("");
  });
}
