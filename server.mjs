import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { deleteStored, readStored, storageMode, writeStored } from "./lib/store.mjs";

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

const ROLE_VALUES = ["Photographer", "Social Media Manager", "Assistant", "Editor"];
const DEFAULT_ACCOUNTS = [
  { name: "Loren", role: "Photographer" },
  { name: "Brooke", role: "Social Media Manager" }
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

async function readSession() {
  return readStored("instagram-session", {});
}
async function writeSession(value) {
  return writeStored("instagram-session", value);
}
async function readCanvaSession(userId) { return readStored(`canva-session-${userId}`, {}); }
async function writeCanvaSession(userId, value) { return writeStored(`canva-session-${userId}`, value); }
async function seedEnvironmentSession() {
  const existing = await readSession();
  if (process.env.INSTAGRAM_ACCESS_TOKEN && !existing.access_token && !existing.disabled) {
    await writeSession({
      access_token: process.env.INSTAGRAM_ACCESS_TOKEN,
      source: "environment",
      stored_at: new Date().toISOString()
    });
  }
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
  const match = String(value || "").match(/\/(?:design|api\/design)\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : "";
}
async function exportCanvaPreview(designId, token) {
  const job = await fetchJson("https://api.canva.com/rest/v1/exports", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ design_id: designId, format: { type: "jpg", quality: 90 } })
  });
  let result = job;
  for (let attempt = 0; attempt < 12 && result.status !== "success"; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    result = await fetchJson(`https://api.canva.com/rest/v1/exports/${job.job?.id || job.id}`, { headers: { Authorization: `Bearer ${token}` } });
  }
  const url = result.urls?.[0] || result.result?.urls?.[0];
  if (!url) throw new Error("Canva did not return a preview yet.");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Canva preview download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const filename = `${crypto.randomUUID()}.jpg`;
  const blob = await blobClient();
  if (blob) {
    const saved = await blob.put(`planner/${filename}`, bytes, { access: "public", contentType: "image/jpeg", addRandomSuffix: false });
    return saved.url;
  }
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, filename), bytes);
  return `/uploads/${filename}`;
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
    const message = data?.error?.message || data?.error_description || `Instagram request failed (${response.status})`;
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
async function getInstagramMedia(token, limit = 12) {
  const all = [];
  let url = new URL(`https://graph.instagram.com/${API_VERSION}/me/media`);
  url.searchParams.set("fields", "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp");
  url.searchParams.set("limit", String(Math.min(100, Math.max(3, Number(limit) || 12))));
  url.searchParams.set("access_token", token);

  for (let page = 0; page < 10 && url; page++) {
    const result = await fetchJson(url);
    all.push(...(result.data || []));
    const next = result.paging?.next;
    url = next ? new URL(next) : null;
  }
  return all.slice(0, Math.min(100, Math.max(3, Number(limit) || 12)));
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

function normalizePost(post) {
  const workflowValues = ["idea", "drafting", "needs-assets", "needs-caption", "needs-review", "approved", "ready-meta", "meta-scheduled", "published", "archived"];
  const workflow = workflowValues.includes(post?.workflow)
    ? post.workflow
    : post?.status === "posted"
      ? "published"
      : post?.approval === "needs-review"
        ? "needs-review"
        : post?.approval === "approved"
          ? "approved"
          : post?.status === "draft" ? "drafting" : "idea";
  return {
    id: String(post?.id || crypto.randomUUID()),
    metaId: post?.metaId ? String(post.metaId) : "",
    image: String(post?.image || ""),
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
    approval: ["draft", "needs-review", "approved"].includes(post?.approval) ? post.approval : "draft",
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
    updatedBy: String(post?.updatedBy || ""),
    updatedAt: post?.updatedAt || new Date().toISOString()
  };
}

function defaultPlanner() {
  return { version: 0, posts: [], team: [], activity: [], settings: defaultSettings(), updatedAt: null };
}
function defaultSettings() {
  return {
    pillars: ["Newborn education", "Family sessions", "Motherhood", "Behind the scenes", "Client stories", "Photographer education", "Personal connection", "Offers and availability"],
    formats: ["IMAGE", "REEL", "CAROUSEL"],
    goals: ["Educate", "Connect", "Showcase work", "Book sessions", "Build trust"],
    syncPhotoCount: 12
  };
}
function normalizeSettings(settings) {
  const base = defaultSettings();
  return {
    pillars: Array.isArray(settings?.pillars) && settings.pillars.length ? settings.pillars.map(item => String(item).trim()).filter(Boolean).slice(0, 40) : base.pillars,
    formats: Array.isArray(settings?.formats) && settings.formats.length ? settings.formats.map(item => String(item).trim().toUpperCase()).filter(Boolean).slice(0, 20) : base.formats,
    goals: Array.isArray(settings?.goals) && settings.goals.length ? settings.goals.map(item => String(item).trim()).filter(Boolean).slice(0, 30) : base.goals,
    syncPhotoCount: Math.min(100, Math.max(3, Number(settings?.syncPhotoCount) || base.syncPhotoCount))
  };
}

async function readPlanner() {
  const planner = await readStored("planner-data", defaultPlanner());
  return {
    version: Number(planner?.version || 0),
    posts: Array.isArray(planner?.posts) ? planner.posts.map(normalizePost) : [],
    team: Array.isArray(planner?.team) ? planner.team : [],
    activity: Array.isArray(planner?.activity) ? planner.activity.slice(0, 40) : [],
    settings: normalizeSettings(planner?.settings),
    updatedAt: planner?.updatedAt || null
  };
}

function upsertTeamMember(planner, actor = {}) {
  if (!actor?.name) return;
  const name = String(actor.name).slice(0, 80);
  const role = String(actor.role || "Teammate").slice(0, 40);
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
  planner.activity.unshift({ text: String(text).slice(0, 180), at: new Date().toISOString() });
  planner.activity = planner.activity.slice(0, 40);
}

async function writePlanner(nextPlanner) {
  const normalized = {
    version: Number(nextPlanner?.version || 0) + 1,
    posts: Array.isArray(nextPlanner?.posts) ? nextPlanner.posts.map(normalizePost) : [],
    team: Array.isArray(nextPlanner?.team) ? nextPlanner.team : [],
    activity: Array.isArray(nextPlanner?.activity) ? nextPlanner.activity.slice(0, 40) : [],
    settings: normalizeSettings(nextPlanner?.settings),
    updatedAt: new Date().toISOString()
  };
  return writeStored("planner-data", normalized);
}
async function readPresence() {
  const stored = await readStored("planner-presence", {});
  const cutoff = Date.now() - 1000 * 60 * 60;
  return Object.values(stored && typeof stored === "object" ? stored : {}).filter(person => Date.parse(person.lastSeenAt || "") > cutoff);
}
async function writePresence(actor = {}) {
  if (!actor?.name) return readPresence();
  const stored = await readStored("planner-presence", {});
  const current = stored && typeof stored === "object" ? stored : {};
  const key = String(actor.name).trim().toLowerCase();
  if (!key) return readPresence();
  current[key] = { name: String(actor.name).slice(0, 80), role: String(actor.role || "Teammate").slice(0, 40), lastSeenAt: new Date().toISOString() };
  const cutoff = Date.now() - 1000 * 60 * 60;
  for (const [name, person] of Object.entries(current)) {
    if (Date.parse(person.lastSeenAt || "") <= cutoff) delete current[name];
  }
  await writeStored("planner-presence", current);
  return Object.values(current);
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

export async function handleRequest(req, res) {
  try {
    await seedEnvironmentSession();
    const url = new URL(req.url, `http://${req.headers.host}`);
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
        user = { id: crypto.randomUUID(), name: "Loren", role: "Photographer", passwordHash: hashPassword(body.password), createdAt: new Date().toISOString() };
        await writeUsers([user]);
        valid = true;
      }
      if (!valid) {
        return sendJson(res, 401, {error: "That name or password didn’t match."});
      }
      setAccountCookie(res, user.id);
      return sendJson(res, 200, {ok:true, user: publicUser(user)});
    }
    if (url.pathname === "/auth/register" && req.method === "POST") {
      const body = await readBody(req);
      const name = String(body.name || "").trim().slice(0, 80);
      const role = ROLE_VALUES.includes(body.role) ? body.role : "Assistant";
      const password = String(body.password || "");
      if (name.length < 2) return sendJson(res, 400, {error: "Enter a display name."});
      if (password.length < 8) return sendJson(res, 400, {error: "Use a password with at least 8 characters."});
      if (users.some(item => item.name.toLowerCase() === name.toLowerCase())) return sendJson(res, 409, {error: "That display name is already in use."});
      const user = { id: crypto.randomUUID(), name, role, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
      await writeUsers([...users, user]);
      setAccountCookie(res, user.id);
      return sendJson(res, 201, {ok:true, user: publicUser(user)});
    }
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
    if (!account) {
      if (url.pathname.startsWith("/api/")) return sendJson(res, 401, {error: "Please sign in to the planner."});
      if (url.pathname !== "/login.html" && url.pathname !== "/login.js" && url.pathname !== "/auth/login" && url.pathname !== "/auth/register") return redirect(res, "/login.html");
    }

    if (url.pathname === "/api/planner" && req.method === "GET") {
      const planner = await readPlanner();
      return sendJson(res, 200, { ...planner, presence: await readPresence() });
    }

    if (url.pathname === "/api/planner/presence" && req.method === "POST") {
      const body = await readBody(req);
      return sendJson(res, 200, { presence: await writePresence(body.actor) });
    }

    if (url.pathname === "/api/planner/bootstrap" && req.method === "POST") {
      const body = await readBody(req);
      const planner = await readPlanner();
      if (!planner.posts.length && Array.isArray(body.seedPosts) && body.seedPosts.length) {
        planner.posts = body.seedPosts.map(normalizePost);
        upsertTeamMember(planner, body.actor);
        addActivity(planner, `${body?.actor?.name || "Team"} started the shared planner`);
        return sendJson(res, 200, await writePlanner(planner));
      }
      if (body?.actor?.name) {
        upsertTeamMember(planner, body.actor);
        return sendJson(res, 200, await writePlanner(planner));
      }
      return sendJson(res, 200, planner);
    }

    if (url.pathname === "/api/planner" && req.method === "PUT") {
      const body = await readBody(req);
      const planner = await readPlanner();
      if (Number.isFinite(Number(body.version)) && Number(body.version) !== planner.version) {
        return sendJson(res, 409, { error: "This planner changed in another browser. Refresh to review the latest version before saving.", planner });
      }
      const previousUrls = new Set(planner.posts.map(post => post.image).filter(Boolean));
      planner.posts = Array.isArray(body.posts) ? body.posts.map(post => normalizePost({ ...post, updatedBy: body?.actor?.name || post.updatedBy })) : planner.posts;
      const nextUrls = new Set(planner.posts.map(post => post.image).filter(Boolean));
      await Promise.all([...previousUrls].filter(url => !nextUrls.has(url)).map(deleteBlobUrl));
      planner.settings = normalizeSettings(body.settings || planner.settings);
      upsertTeamMember(planner, body.actor);
      addActivity(planner, body.reason ? `${body?.actor?.name || "Team"} ${body.reason}` : "");
      return sendJson(res, 200, await writePlanner(planner));
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
      const previewUrl = await exportCanvaPreview(designId, token);
      const session = await readCanvaSession(account.id);
      await writeCanvaSession(account.id, { ...session, last_synced_at: new Date().toISOString() });
      return sendJson(res, 200, { previewUrl });
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
      const [profile, media] = await Promise.all([
        getInstagramProfile(session.access_token),
        getInstagramMedia(session.access_token, planner.settings.syncPhotoCount)
      ]);
      upsertTeamMember(planner, body.actor);
      mergeInstagramPosts(planner, media, body?.actor?.name || "Instagram sync");
      addActivity(planner, `${body?.actor?.name || "Team"} synced Instagram`);
      const saved = await writePlanner(planner);
      await writeSession({...session, last_synced_at: new Date().toISOString()});
      return sendJson(res, 200, { profile, mediaCount: media.length, planner: saved });
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
