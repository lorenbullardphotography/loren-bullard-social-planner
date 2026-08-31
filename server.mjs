import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { deleteStored, readStored, storageMode, writeStored } from "./lib/store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

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
const API_VERSION = process.env.META_API_VERSION || "v25.0";
const PLANNER_PASSWORD = process.env.PLANNER_PASSWORD || "";
const AUTH_SECRET = process.env.AUTH_SECRET || PLANNER_PASSWORD || "planner-development-secret";

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
async function seedEnvironmentSession() {
  const existing = await readSession();
  if (process.env.INSTAGRAM_ACCESS_TOKEN && !existing.access_token) {
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
      if (raw.length > 10 * 1024 * 1024) {
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
  const fields = "user_id,username,name,profile_picture_url,followers_count,follows_count,media_count";
  const url = new URL(`https://graph.instagram.com/${API_VERSION}/me`);
  url.searchParams.set("fields", fields);
  url.searchParams.set("access_token", token);
  return fetchJson(url);
}
async function getInstagramMedia(token) {
  const all = [];
  let url = new URL(`https://graph.instagram.com/${API_VERSION}/me/media`);
  url.searchParams.set("fields", "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp");
  url.searchParams.set("limit", "100");
  url.searchParams.set("access_token", token);

  for (let page = 0; page < 10 && url; page++) {
    const result = await fetchJson(url);
    all.push(...(result.data || []));
    const next = result.paging?.next;
    url = next ? new URL(next) : null;
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
  return {
    id: String(post?.id || crypto.randomUUID()),
    metaId: post?.metaId ? String(post.metaId) : "",
    image: String(post?.image || ""),
    status: post?.status === "posted" ? "posted" : (post?.status === "draft" ? "draft" : "planned"),
    approval: ["draft", "needs-review", "approved"].includes(post?.approval) ? post.approval : "draft",
    type: ["IMAGE", "REEL", "CAROUSEL"].includes(post?.type) ? post.type : "IMAGE",
    date: String(post?.date || ""),
    time: String(post?.time || ""),
    scheduleState: ["draft", "ready", "scheduled"].includes(post?.scheduleState) ? post.scheduleState : "draft",
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
  return { version: 0, posts: [], team: [], activity: [], updatedAt: null };
}

async function readPlanner() {
  const planner = await readStored("planner-data", defaultPlanner());
  return {
    version: Number(planner?.version || 0),
    posts: Array.isArray(planner?.posts) ? planner.posts.map(normalizePost) : [],
    team: Array.isArray(planner?.team) ? planner.team : [],
    activity: Array.isArray(planner?.activity) ? planner.activity.slice(0, 40) : [],
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
    updatedAt: new Date().toISOString()
  };
  return writeStored("planner-data", normalized);
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

    if (url.pathname === "/auth/login" && req.method === "POST") {
      const body = await readBody(req);
      if (!PLANNER_PASSWORD || !passwordsMatch(body.password)) {
        return sendJson(res, 401, {error: "Incorrect planner password."});
      }
      setAuthCookie(res);
      return sendJson(res, 200, {ok:true});
    }
    if (url.pathname === "/auth/logout" && req.method === "POST") {
      clearAuthCookie(res);
      return sendJson(res, 200, {ok:true});
    }
    if (PLANNER_PASSWORD && !isAuthenticated(req)) {
      if (url.pathname.startsWith("/api/")) return sendJson(res, 401, {error: "Please sign in to the planner."});
      if (url.pathname !== "/login.html" && url.pathname !== "/login.js") return redirect(res, "/login.html");
    }

    if (url.pathname === "/api/planner" && req.method === "GET") {
      return sendJson(res, 200, await readPlanner());
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
      planner.posts = Array.isArray(body.posts) ? body.posts.map(post => normalizePost({ ...post, updatedBy: body?.actor?.name || post.updatedBy })) : planner.posts;
      upsertTeamMember(planner, body.actor);
      addActivity(planner, body.reason ? `${body?.actor?.name || "Team"} ${body.reason}` : "");
      return sendJson(res, 200, await writePlanner(planner));
    }

    if (url.pathname === "/api/instagram/status") {
      const session = await readSession();
      if (!session.access_token) {
        return sendJson(res, 200, publicInstagramStatus(session, {redirect_uri: REDIRECT_URI}));
      }
      try {
        const profile = await getInstagramProfile(session.access_token);
        return sendJson(res, 200, publicInstagramStatus(session, {profile}));
      } catch (e) {
        return sendJson(res, 200, publicInstagramStatus(session, {connected:false, error:e.message}));
      }
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
      if (!session.access_token) return sendJson(res, 401, {error:"Instagram is not connected yet."});
      const body = await readBody(req);
      const planner = await readPlanner();
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

    if (url.pathname === "/api/instagram/refresh" && req.method === "POST") {
      const session = await readSession();
      if (!session.access_token) return sendJson(res, 401, {error:"Instagram is not connected yet."});
      const refreshed = await refreshLongLivedToken(session);
      return sendJson(res, 200, {ok:true, stored_at:refreshed.stored_at});
    }

    if (url.pathname === "/api/instagram/disconnect" && req.method === "POST") {
      await deleteStored("instagram-session");
      return sendJson(res, 200, {ok:true});
    }

    if (url.pathname === "/auth/instagram") {
      if (!APP_ID || !APP_SECRET) return redirect(res, "/?meta=config");
      const state = crypto.randomBytes(24).toString("hex");
      const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
      res.setHeader("Set-Cookie", `ig_oauth_state=${encodeURIComponent(state)}; HttpOnly; SameSite=Lax; Path=/${secure}; Max-Age=600`);
      const auth = new URL("https://www.instagram.com/oauth/authorize");
      auth.searchParams.set("client_id", APP_ID);
      auth.searchParams.set("redirect_uri", REDIRECT_URI);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("scope", "instagram_business_basic");
      auth.searchParams.set("state", state);
      return redirect(res, auth.toString());
    }

    if (url.pathname === "/auth/instagram/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error_description") || url.searchParams.get("error");
      if (error) return redirect(res, `/?meta=error&message=${encodeURIComponent(error)}`);
      if (!code) return redirect(res, "/?meta=error&message=No%20authorization%20code%20returned");
      if (!state || state !== readCookies(req).ig_oauth_state) return redirect(res, "/?meta=error&message=OAuth%20state%20did%20not%20match");
      try {
        const session = await exchangeCodeForToken(code);
        await writeSession(session);
        res.setHeader("Set-Cookie", "ig_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
        return redirect(res, "/?meta=connected");
      } catch (e) {
        return redirect(res, `/?meta=error&message=${encodeURIComponent(e.message)}`);
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
