const USER_KEY = "lb-content-planner-user-v1";
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
let selected = null, dragId = null, currentView = "grid", editorReturnView = "grid", libraryFilter = "all", librarySearch = "";
let settings = { pillars: [], formats: ["IMAGE", "REEL", "CAROUSEL"], goals: [], syncPhotoCount: 12 };
let calCursor = new Date(); calCursor.setDate(1);

const demo = (text, bg, fg = "#fff") => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="100%" height="100%" fill="${bg}"/><circle cx="500" cy="390" r="165" fill="rgba(255,255,255,.15)"/><text x="500" y="585" text-anchor="middle" font-family="Georgia" font-size="57" fill="${fg}">${text}</text></svg>`)}`;
const seed = [
  { id: crypto.randomUUID(), image: "/assets/family-films.jpg", assetSource: "uploaded", assetKind: "image", status: "planned", approval: "needs-review", type: "REEL", date: "2026-09-08", time: "09:00", scheduleState: "ready", caption: "", notes: "Use emotional family hook.", comments: [] },
  { id: crypto.randomUUID(), image: "/assets/brand-cover.jpg", assetSource: "uploaded", assetKind: "image", status: "draft", approval: "draft", type: "IMAGE", date: "2026-09-11", time: "11:00", scheduleState: "draft", caption: "", notes: "Carousel idea: studio vs. in-home.", comments: [] },
  { id: crypto.randomUUID(), image: "/assets/couple-mug.png", assetSource: "uploaded", assetKind: "image", status: "planned", approval: "approved", type: "IMAGE", date: "2026-09-15", time: "08:30", scheduleState: "scheduled", caption: "", notes: "Sentimental motherhood caption.", comments: [] }
];

let posts = [];
let team = [];
let activity = [];
let presence = [];
let igStatus = { connected: false };
let plannerVersion = 0;
let currentUser = loadUser();
let initialInstagramSyncDone = false;

async function loadAccount() {
  const data = await api("/api/auth/me");
  if (!data.user) throw new Error("Please sign in to the planner.");
  currentUser = data.user;
  saveUser();
}

function loadUser() {
  try {
    const saved = JSON.parse(localStorage.getItem(USER_KEY));
    if (saved?.name) return { name: saved.name, role: saved.role || "Photographer" };
  } catch {}
  return { name: "Loren", role: "Photographer" };
}
function saveUser() {
  localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
}
function notify(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(notify.t);
  notify.t = setTimeout(() => t.classList.add("hidden"), 2600);
}
function future() { return posts.filter(post => post.status !== "posted" && workflowOf(post) !== "archived"); }
function posted() { return posts.filter(post => post.status === "posted"); }
function visiblePosted() {
  return posted()
    .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))
    .slice(0, Number(settings.syncPhotoCount) || 12);
}
function ordered() { return [...future(), ...visiblePosted()]; }
function esc(s = "") { return s.replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
function safeCanvaUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && /(^|\.)canva\.com$/i.test(url.hostname) ? url.toString() : ""; } catch { return ""; }
}
function assetKindOf(post) {
  if (post.assetKind === "video") return "video";
  if (post.assetKind === "image") return "image";
  return /\.(mp4|mov|webm|m4v)(\?|$)/i.test(post.image || "") ? "video" : "image";
}
function assetSourceOf(post) { return post.assetSource === "canva" || post.canvaUrl ? "canva" : "uploaded"; }
function assetTypeLabel(post) { return assetKindOf(post) === "video" ? "Video" : "Image"; }
function hasReelCover(post) { return post.type === "REEL" && Boolean(post.coverImage); }
function gridImageOf(post) { return hasReelCover(post) ? post.coverImage : post.image; }
function assetMediaMarkup(post, className = "") {
  return assetKindOf(post) === "video"
    ? `<video class="${className}" src="${esc(post.image)}" muted playsinline preload="metadata"></video>`
    : `<img class="${className}" src="${esc(post.image)}" alt="">`;
}
function scheduleLabel(post) {
  return post.scheduleState === "scheduled" ? "Scheduled" : post.scheduleState === "ready" ? "Ready" : "Draft";
}
function formatSchedule(post) {
  const pieces = [];
  if (post.date) pieces.push(post.date);
  if (post.time) pieces.push(post.time);
  if (!pieces.length) pieces.push("Unscheduled");
  pieces.push(scheduleLabel(post));
  return pieces.join(" · ");
}
const WORKFLOW_LABELS = {
  idea: "Idea", drafting: "Drafting", "needs-assets": "Needs assets", "needs-caption": "Needs caption",
  "needs-review": "Needs review", approved: "Approved", "ready-meta": "Ready for Meta",
  "meta-scheduled": "Scheduled in Meta", published: "Published", archived: "Archived"
};
const DEFAULT_PILLARS = ["Newborn education", "Family sessions", "Motherhood", "Behind the scenes", "Client stories", "Photographer education", "Personal connection", "Offers and availability"];
function workflowOf(post) {
  if (post.status === "posted") return "published";
  if (WORKFLOW_LABELS[post.workflow]) return post.workflow;
  if (post.approval === "needs-review") return "needs-review";
  if (post.approval === "approved") return "approved";
  return post.status === "draft" ? "drafting" : "idea";
}
function applyWorkflow(post, workflow) {
  post.workflow = workflow;
  post.status = workflow === "published" ? "posted" : ["approved", "ready-meta", "meta-scheduled"].includes(workflow) ? "planned" : "draft";
  post.approval = workflow === "needs-review" ? "needs-review" : workflow === "approved" || workflow === "ready-meta" || workflow === "meta-scheduled" || workflow === "published" ? "approved" : "draft";
}
function isOverdue(post) {
  return Boolean(post.dueDate && post.dueDate < new Date().toISOString().slice(0, 10) && !["published", "archived"].includes(workflowOf(post)));
}
function setPlanner(data) {
  posts = (Array.isArray(data?.posts) ? data.posts : []).map(post => ({ ...post, assetKind: assetKindOf(post), assetSource: assetSourceOf(post) }));
  team = Array.isArray(data?.team) ? data.team : [];
  activity = Array.isArray(data?.activity) ? data.activity : [];
  presence = Array.isArray(data?.presence) ? data.presence : [];
  settings = { pillars: DEFAULT_PILLARS, formats: ["IMAGE", "REEL", "CAROUSEL"], goals: ["Educate", "Connect", "Showcase work", "Book sessions", "Build trust"], syncPhotoCount: 12, ...(data?.settings || {}) };
  plannerVersion = Number(data?.version || 0);
  if (selected && !posts.find(post => post.id === selected)) selected = null;
}

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "Request failed");
    error.status = response.status;
    error.planner = data.planner;
    throw error;
  }
  return data;
}
async function loadPlanner() {
  const planner = await api("/api/planner");
  if (!planner.posts?.length) {
    const bootstrapped = await api("/api/planner/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seedPosts: seed, actor: currentUser })
    });
    setPlanner(bootstrapped);
    return;
  }
  setPlanner(planner);
  await api("/api/planner/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actor: currentUser })
  }).then(setPlanner).catch(() => {});
}
async function refreshSharedPlanner() {
  try {
    const latest = await api("/api/planner");
    if (Number(latest?.version || 0) > plannerVersion) {
      setPlanner(latest);
      renderAll();
    } else if (Array.isArray(latest?.presence)) {
      presence = latest.presence;
      renderTeam();
    }
  } catch {}
}
async function persistPlanner(reason) {
  try {
    const saved = await api("/api/planner", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: plannerVersion, posts, settings, actor: currentUser, reason })
    });
    setPlanner(saved);
  } catch (error) {
    if (error.status === 409 && error.planner) {
      setPlanner(error.planner);
      renderAll();
      notify("Another browser changed the planner. Your edit was not overwritten.");
    }
    throw error;
  }
}

function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
function exportBackup() {
  downloadFile('loren-content-planner-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify({ exportedAt: new Date().toISOString(), posts }, null, 2), "application/json");
  notify("Backup exported");
}
async function importBackup(file) {
  const raw = await file.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error("That backup file is not valid JSON."); }
  const imported = Array.isArray(data) ? data : data.posts;
  if (!Array.isArray(imported) || !imported.length) throw new Error("No posts were found in that backup.");
  const confirmed = window.confirm('Replace the current planner with ' + imported.length + ' posts from this backup?');
  if (!confirmed) return;
  posts = imported;
  renderAll();
  await persistPlanner("restored a planner backup");
  notify("Backup restored");
}

function renderAll() {
  renderStats();
  renderAttention();
  renderGrid();
  // Only render the editor that is currently visible. Rendering both produced
  // duplicate control IDs, so document-wide selectors could bind to the hidden
  // grid inspector instead of the standalone asset editor.
  if (currentView === "grid") renderInspector();
  else $("#inspector").innerHTML = "";
  if (currentView === "editor") renderInspector("#postEditor");
  else $("#postEditor").innerHTML = "";
  renderCalendar();
  renderLibrary();
  renderApprovals();
  renderTeam();
  renderActivity();
  renderPlannerSettings();
}
function assetPreview(post) {
  const ratio = post.cropRatio || (post.assetKind === "video" ? "9:16" : "4:5");
  const ratioValue = ratio === "1:1" ? "1 / 1" : ratio === "4:5" ? "4 / 5" : ratio === "1.91:1" ? "1.91 / 1" : "9 / 16";
  const zoom = Math.max(1, Number(post.cropZoom) || 1);
  const x = cropCoordinate(post.cropX);
  const y = cropCoordinate(post.cropY);
  return post.assetKind === "video"
    ? '<video class="crop-media" style="aspect-ratio:' + ratioValue + ';transform:translate(' + ((x - 50) * (zoom - 1)) + '%,' + ((y - 50) * (zoom - 1)) + '%) scale(' + zoom + ')" src="' + esc(post.image) + '" controls muted playsinline></video>'
    : '<img class="crop-media" style="aspect-ratio:' + ratioValue + ';transform:translate(' + ((x - 50) * (zoom - 1)) + '%,' + ((y - 50) * (zoom - 1)) + '%) scale(' + zoom + ')" src="' + esc(post.image) + '" alt="">';
}
function cropCoordinate(value) {
  const coordinate = Number(value);
  return Number.isFinite(coordinate) ? Math.max(0, Math.min(100, coordinate)) : 50;
}
function cropTransform(post) {
  const zoom = Math.max(1, Math.min(3, Number(post.cropZoom) || 1));
  const x = cropCoordinate(post.cropX);
  const y = cropCoordinate(post.cropY);
  return `translate(${(x - 50) * (zoom - 1)}%, ${(y - 50) * (zoom - 1)}%) scale(${zoom})`;
}
function cropFrameRatio(post) {
  return post.cropRatio === "1:1" ? "1 / 1" : post.cropRatio === "1.91:1" ? "1.91 / 1" : post.cropRatio === "9:16" ? "9 / 16" : "4 / 5";
}
function locationSummary(post) {
  return post.location ? `<div class="location-summary">⌖ ${esc(post.location)}</div>` : "";
}

async function readExifGps(file) {
  try {
    const bytes = new DataView(await file.arrayBuffer());
    if (bytes.getUint16(0) !== 0xffd8) return null;
    let offset = 2;
    while (offset + 4 < bytes.byteLength) {
      if (bytes.getUint8(offset) !== 0xff || bytes.getUint8(offset + 1) === 0xda) break;
      const marker = bytes.getUint8(offset + 1), length = bytes.getUint16(offset + 2);
      if (marker === 0xe1 && new TextDecoder().decode(new Uint8Array(bytes.buffer, bytes.byteOffset + offset + 4, 6)) === "Exif\0\0") {
        return parseExifGps(bytes, offset + 10);
      }
      offset += 2 + length;
    }
  } catch {}
  return null;
}
function parseExifGps(view, tiff) {
  const little = view.getUint16(tiff) === 0x4949;
  const u16 = o => view.getUint16(o, little), u32 = o => view.getUint32(o, little);
  if (u16(tiff + 2) !== 42) return null;
  const readIfd = at => {
    const out = {};
    if (!at || at + 2 > view.byteLength) return out;
    const count = u16(at);
    for (let i = 0; i < count; i++) {
      const entry = at + 2 + i * 12; if (entry + 12 > view.byteLength) break;
      const tag = u16(entry), type = u16(entry + 2), countValue = u32(entry + 4), size = type === 3 ? 2 : type === 4 ? 4 : type === 5 ? 8 : 1;
      const valueAt = size * countValue <= 4 ? entry + 8 : tiff + u32(entry + 8);
      if (tag === 0x8825) out.gps = tiff + u32(valueAt);
      else if (tag === 1 || tag === 3) out[tag] = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + valueAt, Math.min(countValue, 2))).replace(/\0/g, "");
      else if (tag === 2 || tag === 4) out[tag] = [0, 1, 2].map(i => { const p = valueAt + i * 8; return p + 8 <= view.byteLength ? u32(p) / (u32(p + 4) || 1) : 0; });
    }
    return out;
  };
  const main = readIfd(tiff + u32(tiff + 4)), gps = readIfd(main.gps);
  if (!gps[1] || !gps[3] || !gps[2]?.length || !gps[4]?.length) return null;
  const latitude = (gps[2][0] + gps[2][1] / 60 + gps[2][2] / 3600) * (gps[1] === "S" ? -1 : 1);
  const longitude = (gps[4][0] + gps[4][1] / 60 + gps[4][2] / 3600) * (gps[3] === "W" ? -1 : 1);
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
}
async function readExifGpsFromUrl(url) {
  try { return readExifGps(new File([await (await fetch(url)).arrayBuffer()], "asset.jpg", { type: "image/jpeg" })); } catch { return null; }
}
function renderPlannerSettings() {
  const pillars = $("#settingsPillars");
  if (!pillars) return;
  pillars.value = settings.pillars.join("\n");
  $("#settingsGoals").value = settings.goals.join("\n");
  $("#settingsSyncCount").value = settings.syncPhotoCount;
  $("#settingsFormats").value = settings.formats.join("\n");
  const connected = igStatus.connected;
  $("#settingsConnection").innerHTML = connected ? "<b>Connected ✓</b><br>@" + esc(igStatus.profile?.username || "lorenbullardphotography") + " · " + (igStatus.profile?.media_count ?? "—") + " published items" : "<b>Instagram not connected</b><br>Connect it to sync live posts into the shared planner.";
  $("#settingsConnectLink").classList.toggle("hidden", connected);
  $("#settingsSync").classList.toggle("hidden", !connected);
  $("#settingsDisconnect").classList.toggle("hidden", !connected);
  $("#accountSettingsName").value = currentUser.name;
  $("#accountSettingsRole").value = currentUser.role;
  refreshStorageUsage();
  refreshCanvaStatus();
}
async function refreshCanvaStatus() {
  const host = $("#canvaConnection");
  const link = $("#canvaConnectLink");
  if (!host || !link) return;
  try {
    const status = await api("/api/canva/status");
    if (!status.configured) {
      host.innerHTML = "<b>Not configured</b><br><small>Add Canva Connect credentials to the planner server first.</small>";
      link.classList.add("hidden");
    } else if (status.connected) {
      host.innerHTML = "<b>Connected ✓</b><br><small>Automatic preview refresh is available for Canva drafts.</small>";
      link.textContent = "Reconnect Canva";
    } else {
      host.innerHTML = "<b>Not connected</b><br><small>Connect the shared Canva account used by your team.</small>";
    }
  } catch { host.textContent = "Canva connection status unavailable"; }
}
function formatBytes(bytes) {
  if (!bytes) return "0 MB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0) + " " + units[index];
}
async function refreshStorageUsage() {
  const host = $("#storageUsage");
  if (!host || refreshStorageUsage.running) return;
  refreshStorageUsage.running = true;
  try {
    const usage = await api("/api/storage/usage");
    const remaining = Math.max(0, usage.limitBytes - usage.usedBytes);
    host.innerHTML = '<div class="storage-meter"><span style="width:' + usage.usedPercent + '%"></span></div><strong>' + formatBytes(remaining) + ' remaining</strong><small>' + formatBytes(usage.usedBytes) + ' used of ' + formatBytes(usage.limitBytes) + (usage.configured ? " · Blob connected" : " · Blob not connected") + '</small><small>Planner data: ' + usage.plannerStorage + '</small>';
  } catch (error) {
    host.textContent = "Storage usage unavailable";
  } finally {
    refreshStorageUsage.running = false;
  }
}
function renderAttention() {
  const items = future().filter(post => isOverdue(post) || workflowOf(post) === "needs-review" || workflowOf(post) === "ready-meta" || (post.assignee && post.assignee === currentUser.name)).sort((a, b) => {
    const rank = post => isOverdue(post) ? 0 : workflowOf(post) === "needs-review" ? 1 : workflowOf(post) === "ready-meta" ? 2 : 3;
    return rank(a) - rank(b) || (a.dueDate || "9999").localeCompare(b.dueDate || "9999");
  }).slice(0, 6);
  $("#attentionList").innerHTML = items.length ? items.map(post => {
    const reason = isOverdue(post) ? "Overdue" : workflowOf(post) === "needs-review" ? "Approval requested" : workflowOf(post) === "ready-meta" ? "Ready to hand off" : "Assigned to " + esc(post.assignee);
    return '<button class="attention-card" data-open="' + post.id + '"><img src="' + post.image + '" alt=""><span><b>' + esc(post.notes || post.caption || "Untitled content") + '</b><small>' + reason + ' · ' + esc(post.dueDate || post.date || "No due date") + '</small></span><i>›</i></button>';
  }).join("") : '<div class="empty">Nothing urgent right now. Your next tasks will appear here.</div>';
  $$("#attentionList [data-open]").forEach(node => node.onclick = () => openPost(node.dataset.open));
}
function renderStats() {
  $("#plannedCount").textContent = future().length;
  $("#postedCount").textContent = visiblePosted().length;
  $("#approvalCount").textContent = future().filter(post => post.approval === "needs-review").length;
}
function renderTeam() {
  $("#teamSummary").textContent = team.length > 1 ? `${team.length} teammates in this planner` : `${currentUser.name}'s shared planner`;
  const names = team.slice(0, 3).map(member => `${member.name} · ${member.role}`);
  $("#teamDetail").textContent = names.length ? names.join(" • ") : "Add your name so comments and approvals stay clear.";
  $("#identityBtn").textContent = `${currentUser.name} · ${currentUser.role}`;
  $("#identityName").value = currentUser.name;
  $("#identityRole").value = currentUser.role;
  const now = Date.now();
  const active = presence.filter(person => now - Date.parse(person.lastSeenAt || "") < 45 * 1000);
  $("#presenceList").innerHTML = active.length
    ? active.map(person => `<span class="presence-person"><i></i>${esc(person.name)} <small>${esc(person.role || "Teammate")}</small></span>`).join("")
    : `<span class="presence-empty">No one else is active right now</span>`;
}
async function heartbeat() {
  try {
    const data = await api("/api/planner/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: currentUser })
    });
    presence = Array.isArray(data.presence) ? data.presence : presence;
    renderTeam();
  } catch {}
}
function renderActivity() {
  $("#activityList").innerHTML = activity.length
    ? activity.map(item => `<article class="activity-item"><strong>${esc(item.text)}</strong><span>${new Date(item.at).toLocaleString()}</span></article>`).join("")
    : `<div class="empty">Shared activity will appear here as the team edits, approves, and syncs content.</div>`;
}
function renderGrid() {
  const grid = $("#grid");
  grid.innerHTML = "";
  for (const post of ordered()) {
    const node = $("#tileTpl").content.firstElementChild.cloneNode(true);
    node.dataset.id = post.id;
    node.dataset.status = post.status;
    node.draggable = post.status !== "posted";
    if (!hasReelCover(post) && (post.assetKind === "video" || post.type === "REEL" && /\.((mp4)|(mov)|(webm))($|\?)/i.test(post.image))) {
      const video = document.createElement("video");
      video.src = post.image;
      video.muted = true;
      video.loop = true;
      video.autoplay = true;
      video.playsInline = true;
      video.className = "tile-media";
      node.querySelector("img").replaceWith(video);
    } else node.querySelector("img").src = gridImageOf(post);
    const media = node.querySelector(".tile-media") || node.querySelector("img");
    media.classList.add("crop-rendered");
    media.style.transform = cropTransform(post);
    node.querySelector(".tag").textContent = post.status === "posted" ? "LIVE" : WORKFLOW_LABELS[workflowOf(post)];
    node.querySelector(".location-icon").classList.toggle("hidden", !post.location);
    node.querySelector(".type-icon").textContent = post.type === "REEL" ? "▶" : post.type === "CAROUSEL" ? "▱" : "";
    if (selected === post.id) node.classList.add("selected");
    const quickDelete = node.querySelector(".tile-delete");
    const isInstagramPost = Boolean(post.metaId || post.status === "posted");
    quickDelete.classList.toggle("hidden", isInstagramPost);
    quickDelete.addEventListener("pointerdown", event => event.stopPropagation());
    quickDelete.addEventListener("click", async event => {
      event.stopPropagation();
      if (isInstagramPost) return;
      quickDelete.disabled = true;
      quickDelete.setAttribute("aria-label", "Deleting asset");
      const previousPosts = posts;
      posts = posts.filter(item => item.id !== post.id);
      if (selected === post.id) selected = null;
      try {
        await persistPlanner("removed a post");
        renderAll();
        notify("Post deleted from the shared planner");
      } catch (error) {
        posts = previousPosts;
        renderAll();
        notify(error.message || "The post could not be deleted");
      }
    });
    node.onclick = () => { selected = post.id; renderGrid(); renderInspector(); };
    node.addEventListener("dragstart", event => {
      if (post.status === "posted") return event.preventDefault();
      dragId = post.id;
      node.classList.add("dragging");
    });
    node.addEventListener("dragend", () => {
      dragId = null;
      $$(".tile").forEach(tile => tile.classList.remove("dragging", "target"));
    });
    node.addEventListener("dragover", event => {
      if (dragId && post.status !== "posted") {
        event.preventDefault();
        node.classList.add("target");
      }
    });
    node.addEventListener("dragleave", () => node.classList.remove("target"));
    node.addEventListener("drop", async event => {
      event.preventDefault();
      await reorder(dragId, post.id);
    });
    grid.appendChild(node);
  }
  $("#gridEmpty").classList.toggle("hidden", ordered().length > 0);
}
async function reorder(a, b) {
  if (!a || a === b) return;
  const futurePosts = future();
  const donePosts = posted();
  const fromIndex = futurePosts.findIndex(post => post.id === a);
  const toIndex = futurePosts.findIndex(post => post.id === b);
  if (fromIndex < 0 || toIndex < 0) return;
  const [moved] = futurePosts.splice(fromIndex, 1);
  futurePosts.splice(toIndex, 0, { ...moved, updatedBy: currentUser.name, updatedAt: new Date().toISOString() });
  posts = [...futurePosts, ...donePosts];
  renderAll();
  await persistPlanner("reordered the grid");
}
function renderInspector(hostSelector = "#inspector") {
  const host = $(hostSelector);
  const q = selector => host.querySelector(selector);
  const qq = selector => [...host.querySelectorAll(selector)];
  const post = posts.find(item => item.id === selected);
  if (!post) {
    host.innerHTML = `<div class="inspector-empty"><b>Select a post</b>Click a tile to edit its caption, notes, workflow, or approval.</div>`;
    return;
  }
  if (post.status === "posted") {
    host.innerHTML = `<div class="editor">
      <div class="preview-wrap">${assetPreview(post)}</div>
      <div class="posted-lock">This post is live on Instagram and stays locked in the grid.<br><br><b>${post.timestamp ? new Date(post.timestamp).toLocaleDateString() : "Posted"}</b>${post.permalink ? ` · <a href="${esc(post.permalink)}" target="_blank" rel="noopener noreferrer">Open on Instagram</a>` : ""}<br>${esc(formatSchedule(post))}${locationSummary(post)}</div>
      <label class="field">Caption<textarea rows="8" readonly>${esc(post.caption || "")}</textarea></label>
    </div>`;
    return;
  }
  const comments = (post.comments || []).map(comment => `<div class="comment"><b>${esc(comment.author)}${comment.role ? ` · ${esc(comment.role)}` : ""}</b>${esc(comment.text)}</div>`).join("");
  const workflowOptions = Object.entries(WORKFLOW_LABELS).map(([key, label]) => `<option value="${key}" ${workflowOf(post) === key ? "selected" : ""}>${label}</option>`).join("");
  const pillarOptions = `<option value="">Choose a pillar</option>` + settings.pillars.map(pillar => `<option ${post.pillar === pillar ? "selected" : ""}>${esc(pillar)}</option>`).join("");
  const cropOptions = ["1:1", "4:5", "1.91:1", "9:16"].map(ratio => `<option value="${ratio}" ${post.cropRatio === ratio ? "selected" : ""}>${ratio} ${ratio === "9:16" ? "· Reel / Story" : "· Feed"}</option>`).join("");
  host.innerHTML = `<div class="editor editable-editor"><div class="editor-scroll">
    <div class="preview-wrap crop-preview" style="aspect-ratio:${cropFrameRatio(post)}">${assetPreview(post)}</div>
    <div class="asset-meta"><span class="asset-badge">${assetTypeLabel(post)}</span><span class="asset-badge source-${assetSourceOf(post)}">${assetSourceOf(post) === "canva" ? "Canva added" : "Uploaded"}</span>${hasReelCover(post) ? '<span class="asset-badge cover-badge">Cover attached</span>' : ""}</div>
    ${post.type === "REEL" || assetKindOf(post) === "video" ? `<div class="cover-card"><div><b>Reel cover photo</b><small>${post.coverImage ? "This image appears on the grid instead of the video frame." : "Add an image to choose the frame shown on the grid."}</small></div>${post.coverImage ? `<img class="cover-thumb" src="${esc(post.coverImage)}" alt="Reel cover photo">` : ""}<div class="handoff-actions"><label class="ghost button-link cover-upload-label">${post.coverImage ? "Replace cover" : "Upload cover photo"}<input id="coverInput" type="file" accept="image/*" hidden></label>${post.coverImage ? '<button id="removeCover" class="ghost" type="button">Remove cover</button>' : ""}</div><small id="coverHelp" class="field-help"></small></div>` : ""}
    <div class="location-card"><div><b>Location tag</b><small>Add the place where this content was created.</small></div><label class="field nested">Location<input id="eLocation" maxlength="120" value="${esc(post.location || post.locationTag?.name || "")}" placeholder="Crystal Bridges, Bentonville"></label><button id="readLocationMetadata" class="ghost" type="button">⌖ Check photo metadata</button><small id="locationHelp" class="field-help">We’ll use the photo’s embedded location when available.</small></div>
    ${post.canvaUrl ? `<div class="canva-source"><b>Canva working draft</b><span>Preview refreshes from Canva when connected.</span><div class="handoff-actions"><a class="ghost button-link" href="${esc(post.canvaUrl)}" target="_blank" rel="noopener noreferrer">Open in Canva</a><button id="refreshCanva" class="ghost">Refresh preview</button></div></div>` : ""}
    <label class="field">Instagram crop<select id="eCropRatio">${cropOptions}</select><small class="field-help">The preview uses this frame; the original asset stays unchanged.</small></label>
    <label class="field">Zoom <input id="eCropZoom" type="range" min="1" max="3" step="0.05" value="${post.cropZoom || 1}"><small class="field-help">Drag the preview to pan the crop.</small></label>
    <div class="two">
      <label class="field">Workflow<select id="eWorkflow">${workflowOptions}</select></label>
      <label class="field">Assigned to<input id="eAssignee" value="${esc(post.assignee || "")}" placeholder="Loren or social planner"></label>
    </div>
    <div class="two">
      <label class="field">Due date<input id="eDueDate" type="date" value="${post.dueDate || ""}"></label>
      <label class="field">Priority<select id="ePriority"><option value="low" ${post.priority === "low" ? "selected" : ""}>Low</option><option value="normal" ${post.priority === "normal" ? "selected" : ""}>Normal</option><option value="high" ${post.priority === "high" ? "selected" : ""}>High</option></select></label>
    </div>
    <div class="two">
      <label class="field">Content pillar<select id="ePillar">${pillarOptions}</select></label>
      <label class="field">Format<select id="eType">${settings.formats.map(format => `<option ${post.type === format ? "selected" : ""}>${esc(format)}</option>`).join("")}</select></label>
    </div>
    <label class="field">Scheduling<select id="eScheduleState"><option value="draft" ${post.scheduleState === "draft" ? "selected" : ""}>Not ready</option><option value="ready" ${post.scheduleState === "ready" ? "selected" : ""}>Ready to schedule</option><option value="scheduled" ${post.scheduleState === "scheduled" ? "selected" : ""}>Scheduled</option></select></label>
    <label class="field">Caption<textarea id="eCaption" rows="6" placeholder="Write or paste caption…">${esc(post.caption || "")}</textarea></label>
    <label class="field">Notes<textarea id="eNotes" rows="3" placeholder="Audio, hook, CTA, manager notes…">${esc(post.notes || "")}</textarea></label>
    <div class="field">Content brief
      <label class="field nested">Goal<input id="eGoal" value="${esc(post.goal || "")}" placeholder="What should this post accomplish?"></label>
      <label class="field nested">Hook<input id="eHook" value="${esc(post.hook || "")}" placeholder="Opening line or visual hook"></label>
      <div class="two"><label class="field nested">Call to action<input id="eCta" value="${esc(post.cta || "")}" placeholder="Book, comment, save…"></label><label class="field nested">Audio<input id="eAudio" value="${esc(post.audio || "")}" placeholder="Audio or sound"></label></div>
      <label class="field nested">Hashtags<textarea id="eHashtags" rows="2" placeholder="#northwestarkansas #newbornphotographer">${esc(post.hashtags || "")}</textarea></label>
      <label class="field nested">Tagging notes<input id="eTagNotes" value="${esc(post.tagNotes || "")}" placeholder="People, vendors, collaborators"></label>
      <label class="field nested">Alt text<textarea id="eAltText" rows="2" placeholder="Describe the image for accessibility">${esc(post.altText || "")}</textarea></label>
    </div>
    <div class="field">Approval
      <div class="approval-pills">
        <button data-ap="draft" class="${post.approval === "draft" ? "active" : ""}">Draft</button>
        <button data-ap="needs-review" class="${post.approval === "needs-review" ? "active" : ""}">Review</button>
        <button data-ap="approved" class="${post.approval === "approved" ? "active" : ""}">Approved</button>
      </div>
    </div>
    <div class="field">Comments<div class="comment-list">${comments || `<span style="text-transform:none;font-weight:400">No feedback yet.</span>`}</div>
      <div style="display:flex;gap:6px"><input id="commentText" placeholder="Add feedback as ${esc(currentUser.name)}…" style="flex:1"><button id="addComment" class="ghost">Add</button></div>
    </div>
    <div class="handoff"><b>Meta Business Suite handoff</b><span>Use Meta for final scheduling and publishing.</span><div class="handoff-actions"><button id="copyCaption" class="ghost">Copy caption</button><button id="copyHashtags" class="ghost">Copy hashtags</button><a class="ghost button-link" href="https://business.facebook.com/latest/home" target="_blank" rel="noopener noreferrer">Open Meta</a></div><button id="markMeta" class="primary">Mark ready for Meta</button></div>
    <div class="posted-lock">Last updated${post.updatedBy ? ` by <b>${esc(post.updatedBy)}</b>` : ""}${post.updatedAt ? ` on ${new Date(post.updatedAt).toLocaleString()}` : ""}.</div>
    </div>
    <div class="actions"><button id="saveEdit" class="primary">Save</button><button id="deleteEdit" class="danger">Delete</button></div>
  </div>`;
  qq("[data-ap]").forEach(button => {
    button.onclick = async () => {
      applyWorkflow(post, button.dataset.ap === "draft" ? "drafting" : button.dataset.ap);
      post.updatedBy = currentUser.name;
      post.updatedAt = new Date().toISOString();
      renderAll();
      await persistPlanner(`updated approval for ${post.type.toLowerCase()} content`);
    };
  });
  const cropPreview = q(".crop-preview");
  const cropMedia = q(".crop-media");
  const applyCrop = () => {
    if (!cropPreview || !cropMedia) return;
    cropPreview.style.aspectRatio = cropFrameRatio(post);
    const zoom = Math.max(1, Math.min(3, Number(post.cropZoom) || 1));
    const maxX = Math.max(0, cropPreview.getBoundingClientRect().width * (zoom - 1) / 2);
    const maxY = Math.max(0, cropPreview.getBoundingClientRect().height * (zoom - 1) / 2);
    const x = cropCoordinate(post.cropX);
    const y = cropCoordinate(post.cropY);
    const tx = (x - 50) / 50 * maxX;
    const ty = (y - 50) / 50 * maxY;
    cropMedia.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${zoom})`;
  };
  q("#eCropRatio").onchange = () => { post.cropRatio = q("#eCropRatio").value; applyCrop(); };
  q("#eCropZoom").oninput = () => {
    post.cropZoom = Number(q("#eCropZoom").value);
    applyCrop();
  };
  let dragStart = null;
  cropPreview.ondragstart = event => event.preventDefault();
  cropPreview.onpointerdown = event => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    dragStart = { x: event.clientX, y: event.clientY, cropX: cropCoordinate(post.cropX), cropY: cropCoordinate(post.cropY) };
    cropPreview.setPointerCapture(event.pointerId);
  };
  cropPreview.onpointermove = event => {
    if (!dragStart) return;
    const zoom = Math.max(1, Math.min(3, Number(post.cropZoom) || 1));
    const maxX = Math.max(0, cropPreview.getBoundingClientRect().width * (zoom - 1) / 2);
    const maxY = Math.max(0, cropPreview.getBoundingClientRect().height * (zoom - 1) / 2);
    post.cropX = maxX ? Math.max(0, Math.min(100, dragStart.cropX + (event.clientX - dragStart.x) / maxX * 50)) : 50;
    post.cropY = maxY ? Math.max(0, Math.min(100, dragStart.cropY + (event.clientY - dragStart.y) / maxY * 50)) : 50;
    event.preventDefault();
    applyCrop();
  };
  const stopPan = event => {
    dragStart = null;
    if (event?.pointerId != null && cropPreview.hasPointerCapture(event.pointerId)) cropPreview.releasePointerCapture(event.pointerId);
  };
  cropPreview.onpointerup = stopPan;
  cropPreview.onpointercancel = stopPan;
  cropPreview.onlostpointercapture = () => { dragStart = null; };
  applyCrop();
  q("#saveEdit").onclick = async () => {
    const previousPost = { ...post };
    const saveButton = q("#saveEdit");
    saveButton.disabled = true;
    saveButton.textContent = "Saving…";
    post.type = q("#eType").value;
    post.cropRatio = q("#eCropRatio").value;
    applyWorkflow(post, q("#eWorkflow").value);
    post.assignee = q("#eAssignee").value.trim();
    post.dueDate = q("#eDueDate").value;
    post.priority = q("#ePriority").value;
    post.pillar = q("#ePillar").value;
    post.scheduleState = q("#eScheduleState").value;
    post.caption = q("#eCaption").value;
    post.notes = q("#eNotes").value;
    post.goal = q("#eGoal").value.trim();
    post.hook = q("#eHook").value.trim();
    post.cta = q("#eCta").value.trim();
    post.audio = q("#eAudio").value.trim();
    post.hashtags = q("#eHashtags").value.trim();
    post.tagNotes = q("#eTagNotes").value.trim();
    post.altText = q("#eAltText").value.trim();
    post.location = q("#eLocation").value.trim();
    post.locationTag = post.location ? { ...(post.locationTag || {}), name: post.location, source: post.locationTag?.source || "manual" } : null;
    post.updatedBy = currentUser.name;
    post.updatedAt = new Date().toISOString();
    try {
      await persistPlanner("updated planned content");
      renderAll();
      notify("Post updated");
    } catch (error) {
      if (error.status !== 409) Object.assign(post, previousPost);
      renderAll();
      notify(error.message || "The post could not be saved");
    }
  };
  q("#deleteEdit").onclick = async () => {
    if (post.metaId) return notify("Instagram posts stay in the grid");
    const previousPosts = posts;
    const deleteButton = q("#deleteEdit");
    deleteButton.disabled = true;
    deleteButton.textContent = "Deleting…";
    posts = posts.filter(item => item.id !== post.id);
    selected = null;
    try {
      await persistPlanner("removed a post");
      if (currentView === "editor") switchView("grid");
      renderAll();
      notify("Post deleted from the shared planner");
    } catch (error) {
      posts = previousPosts;
      renderAll();
      notify(error.message || "The post could not be deleted");
    }
  };
  const copyText = async (value, label) => {
    if (!value) return notify(`No ${label.toLowerCase()} to copy yet`);
    await navigator.clipboard.writeText(value);
    notify(`${label} copied`);
  };
  q("#copyCaption").onclick = () => copyText(post.caption, "Caption");
  q("#copyHashtags").onclick = () => copyText(post.hashtags, "Hashtags");
  if (q("#refreshCanva")) q("#refreshCanva").onclick = () => refreshCanvaPreview(post);
  if (q("#coverInput")) q("#coverInput").onchange = async event => {
    const [file] = event.target.files;
    if (!file) return;
    if (!file.type.startsWith("image/")) return notify("Choose an image for the reel cover");
    if (file.size > 30 * 1024 * 1024) return notify("Cover photos must be 30 MB or smaller");
    const help = q("#coverHelp");
    if (help) help.textContent = "Uploading cover photo…";
    try {
      const uploaded = await api("/api/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, data: await readFile(file) }) });
      post.coverImage = uploaded.url;
      post.updatedBy = currentUser.name;
      post.updatedAt = new Date().toISOString();
      await persistPlanner("added a reel cover photo");
      renderAll();
      notify("Reel cover photo attached");
    } catch (error) { if (help) help.textContent = "Cover upload failed"; notify(error.message || "Cover photo upload failed"); }
    finally { event.target.value = ""; }
  };
  if (q("#removeCover")) q("#removeCover").onclick = async () => {
    const previousCover = post.coverImage;
    post.coverImage = "";
    post.updatedBy = currentUser.name;
    post.updatedAt = new Date().toISOString();
    try { await persistPlanner("removed a reel cover photo"); renderAll(); notify("Reel cover removed"); }
    catch (error) { post.coverImage = previousCover; renderAll(); notify(error.message || "Reel cover could not be removed"); }
  };
  q("#markMeta").onclick = async () => {
    applyWorkflow(post, "ready-meta");
    post.updatedBy = currentUser.name;
    post.updatedAt = new Date().toISOString();
    renderAll();
    await persistPlanner("marked content ready for Meta Business Suite");
    notify("Ready for Meta Business Suite");
  };
  q("#readLocationMetadata").onclick = async () => {
    if (assetSourceOf(post) !== "uploaded" || assetKindOf(post) !== "image") return notify("GPS metadata is available for uploaded photos");
    const gps = await readExifGpsFromUrl(post.image);
    if (!gps) return notify("No location metadata found in this photo");
    q("#eLocation").value = "Photo location";
    q("#locationHelp").textContent = "Location metadata found. Replace this with the place name you want displayed.";
    post.locationTag = { ...(post.locationTag || {}), source: "metadata" };
    notify("Photo location found");
  };
  q("#addComment").onclick = async () => {
    const value = q("#commentText").value.trim();
    if (!value) return;
    (post.comments ||= []).push({ author: currentUser.name, role: currentUser.role, text: value, at: new Date().toISOString() });
    post.updatedBy = currentUser.name;
    post.updatedAt = new Date().toISOString();
    renderInspector();
    renderApprovals();
    renderActivity();
    await persistPlanner("left feedback on a post");
  };
}
async function refreshCanvaPreview(post) {
  const button = $("#refreshCanva");
  if (button) { button.disabled = true; button.textContent = "Refreshing…"; }
  try {
    const data = await api("/api/canva/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ canvaUrl: post.canvaUrl, designId: post.canvaDesignId }) });
    post.image = data.previewUrl;
    post.canvaPreviewUpdatedAt = new Date().toISOString();
    post.updatedBy = currentUser.name;
    post.updatedAt = new Date().toISOString();
    renderAll();
    await persistPlanner("refreshed a Canva preview");
    notify("Canva preview refreshed");
  } catch (error) { notify(error.message || "Canva preview could not be refreshed"); }
  finally {
    if (button) { button.disabled = false; button.textContent = "Refresh preview"; }
  }
}
function renderCalendar() {
  const year = calCursor.getFullYear(), month = calCursor.getMonth();
  $("#monthLabel").textContent = calCursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const begin = new Date(year, month, 1 - new Date(year, month, 1).getDay());
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let html = names.map(name => `<div class="cal-head">${name}</div>`).join("");
  for (let i = 0; i < 42; i++) {
    const day = new Date(begin);
    day.setDate(begin.getDate() + i);
    const iso = day.toISOString().slice(0, 10);
    const items = future().filter(post => post.date === iso);
    html += `<div class="day ${day.getMonth() !== month ? "muted" : ""}" data-day="${iso}"><div class="day-num">${day.getDate()}</div>${items.map(post => `<div class="cal-post" draggable="true" data-open="${post.id}" data-drag-post="${post.id}"><img src="${post.image}"><span>${esc((post.caption || post.notes || post.type || "Post").slice(0, 28))}<small>${esc(post.time || scheduleLabel(post))}</small></span></div>`).join("")}</div>`;
  }
  $("#calendar").innerHTML = html;
  $$("[data-open]").forEach(node => node.onclick = () => openPost(node.dataset.open));
  $$("[data-drag-post]").forEach(node => node.ondragstart = event => { dragId = node.dataset.dragPost; event.stopPropagation(); });
  $$(".day[data-day]").forEach(node => {
    node.ondragover = event => { if (dragId) event.preventDefault(); };
    node.ondrop = async event => { event.preventDefault(); const post = posts.find(item => item.id === dragId); if (!post) return; post.date = node.dataset.day; post.updatedBy = currentUser.name; post.updatedAt = new Date().toISOString(); dragId = null; renderAll(); await persistPlanner("moved content on the calendar"); notify("Publish date updated"); };
  });
}
function renderLibrary() {
  const query = librarySearch.toLowerCase();
  const items = future().filter(post => {
    const matchesFilter = libraryFilter === "all" || post.status === libraryFilter || post.approval === libraryFilter || workflowOf(post) === libraryFilter;
    const searchable = [post.caption, post.notes, post.pillar, post.client, post.assignee, post.goal, post.hook, post.location].join(" ").toLowerCase();
    return matchesFilter && (!query || searchable.includes(query));
  });
  $("#library").innerHTML = items.length
    ? items.map(post => `<article class="library-card" data-open-editor="${post.id}"><div class="library-media">${assetMediaMarkup(post)}</div><div class="library-badges"><span class="asset-badge">${assetTypeLabel(post)}</span><span class="asset-badge source-${assetSourceOf(post)}">${assetSourceOf(post) === "canva" ? "Canva added" : "Uploaded"}</span></div><div class="library-info"><b>${esc(post.notes || post.caption || "Untitled content")}</b><span>${esc(`${post.type} · ${formatSchedule(post)} · ${WORKFLOW_LABELS[workflowOf(post)]}${post.pillar ? ` · ${post.pillar}` : ""}`)}</span>${post.location ? `<small class="library-location">⌖ ${esc(post.location)}</small>` : ""}</div></article>`).join("")
    : `<div class="empty">No content in this view yet.</div>`;
  $$("[data-open-editor]").forEach(node => node.onclick = () => openPost(node.dataset.openEditor, true));
}
function renderApprovals() {
  const columns = [["drafting", "Drafting"], ["needs-review", "Needs Review"], ["approved", "Approved"], ["ready-meta", "Ready for Meta"], ["meta-scheduled", "Scheduled in Meta"]];
  $("#approvalBoard").innerHTML = columns.map(([key, label]) => `<section class="approval-col"><h4>${label}</h4>${future().filter(post => workflowOf(post) === key).map(post => `<article class="approval-card" data-open="${post.id}"><img src="${post.image}"><b>${esc(post.notes || post.caption || post.type)}</b><span>${esc(formatSchedule(post))}</span></article>`).join("") || `<div class="empty">Nothing here.</div>`}</section>`).join("");
  $$("[data-open]").forEach(node => node.onclick = () => openPost(node.dataset.open));
}
function openPost(id, openEditor = false) {
  selected = id;
  if (openEditor) {
    editorReturnView = currentView;
    switchView("editor");
  } else {
    switchView("grid");
    renderGrid();
    renderInspector();
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function switchView(name) {
  currentView = name;
  $$(".view").forEach(view => view.classList.add("hidden"));
  $(`#view-${name}`).classList.remove("hidden");
  $$(".nav").forEach(nav => nav.classList.toggle("active", nav.dataset.view === name));
  $("#pageTitle").textContent = { grid: "Grid Planner", calendar: "Calendar", library: "Content Library", approvals: "Approvals", activity: "Team Activity", editor: "Edit post", settings: "Settings" }[name];
  if (name !== "grid") $("#inspector").innerHTML = "";
  if (name !== "editor") $("#postEditor").innerHTML = "";
  if (name === "settings") renderPlannerSettings();
  if (name === "activity") renderActivity();
  if (name === "grid") renderInspector();
  if (name === "editor") renderInspector("#postEditor");
}
async function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

$("#upload").onchange = async event => {
  const files = [...event.target.files];
  const oversized = files.filter(file => file.size > 30 * 1024 * 1024);
  if (oversized.length) notify("Assets over 30 MB were skipped");
  const validFiles = files.filter(file => file.size <= 30 * 1024 * 1024);
  if (!validFiles.length) return event.target.value = "";
  const uploadStatus = $("#uploadStatus");
  const addAssetLabel = $("#addAssetLabel");
  uploadStatus.classList.remove("hidden");
  $("#upload").disabled = true;
  addAssetLabel.classList.add("disabled");
  let firstId = null;
  const uploadedPosts = [];
  try {
    for (const [index, file] of validFiles.entries()) {
      uploadStatus.textContent = "Uploading " + (index + 1) + " of " + validFiles.length + "…";
      const photoGps = file.type.startsWith("image/") ? await readExifGps(file) : null;
      const uploaded = await api("/api/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, data: await readFile(file) }) });
      const id = crypto.randomUUID();
      firstId ||= id;
      const uploadedPost = {
        id,
        image: uploaded.url,
        assetKind: uploaded.kind,
        assetSource: "uploaded",
        cropRatio: uploaded.kind === "video" ? "9:16" : "4:5",
        status: "draft",
        approval: "draft",
        type: uploaded.kind === "video" ? "REEL" : "IMAGE",
        date: "",
        time: "",
        scheduleState: "draft",
        caption: "",
        notes: "",
        location: photoGps ? "Photo location" : "",
        locationTag: photoGps ? { name: "Photo location", latitude: photoGps.latitude, longitude: photoGps.longitude, source: "metadata" } : null,
        tags: [],
        comments: [],
        updatedBy: currentUser.name,
        updatedAt: new Date().toISOString()
      };
      uploadedPosts.push(uploadedPost);
      posts.unshift(uploadedPost);
    }
    selected = firstId;
    renderAll();
    try {
      await persistPlanner("uploaded new content");
    } catch (error) {
      if (error.status !== 409 || !error.planner) throw error;
      const uploadedIds = new Set(uploadedPosts.map(post => post.id));
      setPlanner(error.planner);
      posts = [...uploadedPosts, ...posts.filter(post => !uploadedIds.has(post.id))];
      await persistPlanner("uploaded new content after a shared planner refresh");
    }
    switchView("editor");
    notify(validFiles.length === 1 ? "Asset uploaded — finish editing the post" : validFiles.length + " assets uploaded — editing the first post");
  } catch (error) {
    notify(error.message || "Asset upload failed");
  } finally {
    uploadStatus.textContent = "";
    uploadStatus.classList.add("hidden");
    $("#upload").disabled = false;
    addAssetLabel.classList.remove("disabled");
    event.target.value = "";
  }
};
async function loadCanvaDesigns(query = "") {
  const host = $("#canvaDesignList");
  host.innerHTML = '<div class="empty">Loading Canva designs…</div>';
  try {
    const data = await api(`/api/canva/designs${query ? `?query=${encodeURIComponent(query)}` : ""}`);
    host.innerHTML = data.designs?.length ? data.designs.map(design => `<button class="canva-design" data-canva-id="${esc(design.id)}"><img src="${esc(design.thumbnail)}" alt=""><span><b>${esc(design.title)}</b><small>${design.updatedAt ? new Date(design.updatedAt * 1000).toLocaleDateString() : "Canva design"}</small></span></button>`).join("") : '<div class="empty">No Canva designs found.</div>';
    $$("[data-canva-id]").forEach(button => button.onclick = () => addCanvaDesign(data.designs.find(design => design.id === button.dataset.canvaId)));
  } catch (error) { host.innerHTML = `<div class="empty">${esc(error.message || "Canva designs could not be loaded")}</div>`; }
}
function addCanvaDesign(design) {
  if (!design) return;
  const id = crypto.randomUUID();
  const post = { id, image: design.thumbnail || "/assets/brand-cover.jpg", assetSource: "canva", canvaUrl: design.editUrl || design.viewUrl, canvaDesignId: design.id, assetKind: "image", cropRatio: "4:5", status: "draft", approval: "draft", type: "IMAGE", date: "", time: "", scheduleState: "draft", caption: "", notes: design.title, comments: [], updatedBy: currentUser.name, updatedAt: new Date().toISOString() };
  posts.unshift(post); selected = id; $("#canvaModal").classList.add("hidden"); renderAll();
  persistPlanner("added a Canva working draft").then(() => notify("Canva draft added")).catch(error => { posts = posts.filter(item => item.id !== id); renderAll(); notify(error.message || "Canva draft could not be added"); });
}
$("#addCanvaBtn").onclick = async () => {
  $("#canvaModal").classList.remove("hidden");
  $("#canvaSearch").value = "";
  await loadCanvaDesigns();
};
$("#closeCanva").onclick = () => $("#canvaModal").classList.add("hidden");
$("#canvaSearch").oninput = event => { clearTimeout(loadCanvaDesigns.timer); loadCanvaDesigns.timer = setTimeout(() => loadCanvaDesigns(event.target.value.trim()), 300); };
$("#exportBtn").onclick = exportBackup;
$("#importInput").onchange = async event => {
  const [file] = event.target.files;
  if (!file) return;
  try { await importBackup(file); } catch (error) { notify(error.message); }
  event.target.value = "";
};
$$(".nav").forEach(nav => nav.onclick = () => switchView(nav.dataset.view));
$("#prevMonth").onclick = () => { calCursor.setMonth(calCursor.getMonth() - 1); renderCalendar(); };
$("#nextMonth").onclick = () => { calCursor.setMonth(calCursor.getMonth() + 1); renderCalendar(); };
$$(".chip").forEach(chip => chip.onclick = () => {
  libraryFilter = chip.dataset.filter;
  $$(".chip").forEach(item => item.classList.toggle("active", item === chip));
  renderLibrary();
});
$("#librarySearch").oninput = event => { librarySearch = event.target.value.trim(); renderLibrary(); };

async function checkInstagram() {
  try {
    igStatus = await api("/api/instagram/status");
    const connected = igStatus.connected;
    $("#liveBadge").classList.toggle("offline", !connected);
    $("#liveBadge").textContent = connected ? "Instagram connected" : "Not connected";
    if (connected) {
      $("#profileUsername").textContent = `@${igStatus.profile?.username || "lorenbullardphotography"}`;
      const pieces = [];
      if (igStatus.profile?.followers_count != null) pieces.push(`${Number(igStatus.profile.followers_count).toLocaleString()} followers`);
      if (igStatus.profile?.media_count != null) pieces.push(`${igStatus.profile.media_count} posts`);
      if (pieces.length) $("#profileMeta").textContent = pieces.join(" • ");
    }
    renderSettings();
  } catch (error) {
    renderSettings(error.message);
  }
}
function renderSettings(extra = "") {
  const connected = igStatus.connected;
  const lastSync = igStatus.last_synced_at ? `Last synced ${new Date(igStatus.last_synced_at).toLocaleString()}.` : "No Instagram sync has run yet.";
  $("#settingsStatus").innerHTML = connected
    ? `<b>Connected ✓</b><br>Instagram: @${esc(igStatus.profile?.username || "lorenbullardphotography")}<br>${igStatus.profile?.media_count ?? "—"} published media items.<br><small>${esc(lastSync)}</small>`
    : igStatus.configured
      ? `<b>Meta app is configured.</b><br>Choose Connect Instagram and authorize @lorenbullardphotography.${igStatus.error ? `<br><br>${esc(igStatus.error)}` : ""}`
      : `<b>One setup step remains.</b><br>Add your Meta Instagram App ID and App Secret to the local <code>.env</code> file, then restart the planner.${extra ? `<br><br>${esc(extra)}` : ""}`;
  $("#connectLink").classList.toggle("hidden", connected);
  $("#modalSync").classList.toggle("hidden", !connected);
  $("#disconnectBtn").classList.toggle("hidden", !connected);
}
async function syncInstagram({silent = false} = {}) {
  try {
    if (!silent) notify("Syncing Instagram…");
    const data = await api("/api/instagram/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: currentUser })
    });
    setPlanner(data.planner);
    renderAll();
    await checkInstagram();
    if (!silent) notify(`Synced ${data.mediaCount} Instagram posts`);
  } catch (error) {
    notify(error.message);
    $("#settingsModal").classList.remove("hidden");
  }
}

// The planner and Instagram connection live on the server. Periodic refreshes
// let the owner and social employee see each other's changes without sharing a
// browser session or relying on browser storage.
setInterval(refreshSharedPlanner, 10000);
setInterval(checkInstagram, 30000);
setInterval(heartbeat, 20000);
window.addEventListener("focus", () => { refreshSharedPlanner(); checkInstagram(); });

$("#modalSync").onclick = syncInstagram;
$("#settingsBtn").onclick = () => { $("#settingsModal").classList.remove("hidden"); renderSettings(); };
$("#settingsBtn").onclick = () => switchView("settings");
$("#saveSettings").onclick = async () => {
  const pillars = $("#settingsPillars").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const goals = $("#settingsGoals").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const formats = $("#settingsFormats").value.split(/\r?\n/).map(value => value.trim().toUpperCase()).filter(Boolean);
  if (!pillars.length || !formats.length) return notify("Add at least one pillar and one format");
  settings = { pillars, formats, goals, syncPhotoCount: Math.min(100, Math.max(3, Number($("#settingsSyncCount").value) || 12)) };
  await persistPlanner("updated planner settings");
  renderAll();
  notify("Settings saved for the whole team");
};
$("#settingsSync").onclick = syncInstagram;
$("#settingsDisconnect").onclick = async () => {
  await api("/api/instagram/disconnect", { method: "POST" });
  igStatus = { connected: false, configured: true };
  await checkInstagram();
  notify("Instagram disconnected");
};
$("#backToGrid").onclick = () => switchView(editorReturnView);
$("#closeSettings").onclick = () => $("#settingsModal").classList.add("hidden");
$("#settingsModal").onclick = event => { if (event.target.id === "settingsModal") $("#settingsModal").classList.add("hidden"); };
$("#disconnectBtn").onclick = async () => {
  await api("/api/instagram/disconnect", { method: "POST" });
  igStatus = { connected: false, configured: true };
  await checkInstagram();
  notify("Instagram disconnected");
};

$("#identityBtn").onclick = () => $("#identityModal").classList.remove("hidden");
$("#closeIdentity").onclick = () => $("#identityModal").classList.add("hidden");
$("#identityModal").onclick = event => { if (event.target.id === "identityModal") $("#identityModal").classList.add("hidden"); };
$("#saveIdentity").onclick = async () => {
  const name = $("#identityName").value.trim() || "Loren";
  const role = $("#identityRole").value;
  try {
    const data = await api("/api/auth/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, role }) });
    currentUser = data.user;
    saveUser();
    $("#identityModal").classList.add("hidden");
    await loadPlanner();
    renderAll();
    notify("Account updated");
  } catch (error) { notify(error.message); }
};
$("#logoutBtn").onclick = async () => {
  await fetch("/auth/logout", { method: "POST" });
  location.href = "/login.html";
};
$("#saveAccountSettings").onclick = async () => {
  try {
    const passwordField = $("#accountSettingsPassword");
    const data = await api("/api/auth/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("#accountSettingsName").value.trim(), role: $("#accountSettingsRole").value, password: passwordField.value }) });
    currentUser = data.user;
    saveUser();
    passwordField.value = "";
    await loadPlanner();
    renderAll();
    notify("User settings saved");
  } catch (error) { notify(error.message); }
};
$("#accountLogoutBtn").onclick = async () => {
  await fetch("/auth/logout", { method: "POST" });
  location.href = "/login.html";
};

const query = new URLSearchParams(location.search);
if (query.get("meta") === "connected") {
  history.replaceState({}, "", "/");
  setTimeout(() => syncInstagram(), 250);
}
if (query.get("meta") === "config") {
  history.replaceState({}, "", "/");
  $("#settingsModal").classList.remove("hidden");
  notify("Add your Meta app credentials first");
}
if (query.get("meta") === "error") {
  const message = query.get("message") || "Instagram connection failed";
  history.replaceState({}, "", "/");
  $("#settingsModal").classList.remove("hidden");
  notify(message);
}

async function init() {
  await loadAccount();
  await loadPlanner();
  renderAll();
  await heartbeat();
  await checkInstagram();
  if (igStatus.connected && !initialInstagramSyncDone) {
    initialInstagramSyncDone = true;
    await syncInstagram({silent: true});
  }
}

init().catch(error => {
  notify(error.message || "Planner failed to load");
});
