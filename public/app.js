const USER_KEY = "lb-content-planner-user-v1";
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
let selected = null, dragId = null, currentView = "grid", libraryFilter = "all";
let calCursor = new Date(); calCursor.setDate(1);

const demo = (text, bg, fg = "#fff") => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="100%" height="100%" fill="${bg}"/><circle cx="500" cy="390" r="165" fill="rgba(255,255,255,.15)"/><text x="500" y="585" text-anchor="middle" font-family="Georgia" font-size="57" fill="${fg}">${text}</text></svg>`)}`;
const seed = [
  { id: crypto.randomUUID(), image: demo("Fall family reel", "#aa9a8a"), status: "planned", approval: "needs-review", type: "REEL", date: "2026-09-08", time: "09:00", scheduleState: "ready", caption: "", notes: "Use emotional family hook.", comments: [] },
  { id: crypto.randomUUID(), image: demo("Newborn education", "#d7cec4", "#453e38"), status: "draft", approval: "draft", type: "IMAGE", date: "2026-09-11", time: "11:00", scheduleState: "draft", caption: "", notes: "Carousel idea: studio vs. in-home.", comments: [] },
  { id: crypto.randomUUID(), image: demo("Motherhood story", "#a89b90"), status: "planned", approval: "approved", type: "IMAGE", date: "2026-09-15", time: "08:30", scheduleState: "scheduled", caption: "", notes: "Sentimental motherhood caption.", comments: [] }
];

let posts = [];
let team = [];
let activity = [];
let igStatus = { connected: false };
let plannerVersion = 0;
let currentUser = loadUser();
let initialInstagramSyncDone = false;

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
function future() { return posts.filter(post => post.status !== "posted"); }
function posted() { return posts.filter(post => post.status === "posted"); }
function ordered() { return [...future(), ...posted().sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))]; }
function esc(s = "") { return s.replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
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
function setPlanner(data) {
  posts = Array.isArray(data?.posts) ? data.posts : [];
  team = Array.isArray(data?.team) ? data.team : [];
  activity = Array.isArray(data?.activity) ? data.activity : [];
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
    }
  } catch {}
}
async function persistPlanner(reason) {
  try {
    const saved = await api("/api/planner", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: plannerVersion, posts, actor: currentUser, reason })
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
  renderGrid();
  renderInspector();
  renderCalendar();
  renderLibrary();
  renderApprovals();
  renderTeam();
  renderActivity();
}
function renderStats() {
  $("#plannedCount").textContent = future().length;
  $("#postedCount").textContent = posted().length;
  $("#approvalCount").textContent = future().filter(post => post.approval === "needs-review").length;
}
function renderTeam() {
  $("#teamSummary").textContent = team.length > 1 ? `${team.length} teammates in this planner` : `${currentUser.name}'s shared planner`;
  const names = team.slice(0, 3).map(member => `${member.name} · ${member.role}`);
  $("#teamDetail").textContent = names.length ? names.join(" • ") : "Add your name so comments and approvals stay clear.";
  $("#identityBtn").textContent = `${currentUser.name} · ${currentUser.role}`;
  $("#identityName").value = currentUser.name;
  $("#identityRole").value = currentUser.role;
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
    node.querySelector("img").src = post.image;
    node.querySelector(".tag").textContent = post.status === "posted" ? "LIVE" : (post.approval === "approved" ? "APPROVED" : post.status);
    node.querySelector(".type-icon").textContent = post.type === "REEL" ? "▶" : post.type === "CAROUSEL" ? "▱" : "";
    if (selected === post.id) node.classList.add("selected");
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
function renderInspector() {
  const host = $("#inspector");
  const post = posts.find(item => item.id === selected);
  if (!post) {
    host.innerHTML = `<div class="inspector-empty"><b>Select a post</b>Click a tile to edit its caption, date, notes, approval, or scheduling.</div>`;
    return;
  }
  if (post.status === "posted") {
    host.innerHTML = `<div class="editor">
      <div class="preview-wrap"><img src="${post.image}"></div>
      <div class="posted-lock">This post is live on Instagram and stays locked in the grid.<br><br><b>${post.timestamp ? new Date(post.timestamp).toLocaleDateString() : "Posted"}</b>${post.permalink ? ` · <a href="${post.permalink}" target="_blank">Open on Instagram</a>` : ""}<br>${esc(formatSchedule(post))}</div>
      <label class="field">Caption<textarea rows="8" readonly>${esc(post.caption || "")}</textarea></label>
    </div>`;
    return;
  }
  const comments = (post.comments || []).map(comment => `<div class="comment"><b>${esc(comment.author)}${comment.role ? ` · ${esc(comment.role)}` : ""}</b>${esc(comment.text)}</div>`).join("");
  host.innerHTML = `<div class="editor">
    <div class="preview-wrap"><img src="${post.image}"></div>
    <div class="two">
      <label class="field">Format<select id="eType"><option ${post.type === "IMAGE" ? "selected" : ""}>IMAGE</option><option ${post.type === "REEL" ? "selected" : ""}>REEL</option><option ${post.type === "CAROUSEL" ? "selected" : ""}>CAROUSEL</option></select></label>
      <label class="field">Publish date<input id="eDate" type="date" value="${post.date || ""}"></label>
    </div>
    <div class="two">
      <label class="field">Publish time<input id="eTime" type="time" value="${post.time || ""}"></label>
      <label class="field">Scheduling<select id="eScheduleState"><option value="draft" ${post.scheduleState === "draft" ? "selected" : ""}>Not ready</option><option value="ready" ${post.scheduleState === "ready" ? "selected" : ""}>Ready to schedule</option><option value="scheduled" ${post.scheduleState === "scheduled" ? "selected" : ""}>Scheduled</option></select></label>
    </div>
    <label class="field">Caption<textarea id="eCaption" rows="6" placeholder="Write or paste caption…">${esc(post.caption || "")}</textarea></label>
    <label class="field">Notes<textarea id="eNotes" rows="3" placeholder="Audio, hook, CTA, manager notes…">${esc(post.notes || "")}</textarea></label>
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
    <div class="posted-lock">Last updated${post.updatedBy ? ` by <b>${esc(post.updatedBy)}</b>` : ""}${post.updatedAt ? ` on ${new Date(post.updatedAt).toLocaleString()}` : ""}.</div>
    <div class="actions"><button id="saveEdit" class="primary">Save</button><button id="deleteEdit" class="danger">Delete</button></div>
  </div>`;
  $$("[data-ap]").forEach(button => {
    button.onclick = async () => {
      post.approval = button.dataset.ap;
      post.status = post.approval === "draft" ? "draft" : "planned";
      post.updatedBy = currentUser.name;
      post.updatedAt = new Date().toISOString();
      renderAll();
      await persistPlanner(`updated approval for ${post.type.toLowerCase()} content`);
    };
  });
  $("#saveEdit").onclick = async () => {
    post.type = $("#eType").value;
    post.date = $("#eDate").value;
    post.time = $("#eTime").value;
    post.scheduleState = $("#eScheduleState").value;
    post.caption = $("#eCaption").value;
    post.notes = $("#eNotes").value;
    post.status = post.approval === "draft" ? "draft" : "planned";
    post.updatedBy = currentUser.name;
    post.updatedAt = new Date().toISOString();
    renderAll();
    await persistPlanner("updated planned content");
    notify("Post updated");
  };
  $("#deleteEdit").onclick = async () => {
    posts = posts.filter(item => item.id !== post.id);
    selected = null;
    renderAll();
    await persistPlanner("removed a post");
    notify("Post deleted");
  };
  $("#addComment").onclick = async () => {
    const value = $("#commentText").value.trim();
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
    html += `<div class="day ${day.getMonth() !== month ? "muted" : ""}"><div class="day-num">${day.getDate()}</div>${items.map(post => `<div class="cal-post" data-open="${post.id}"><img src="${post.image}"><span>${esc((post.caption || post.notes || post.type || "Post").slice(0, 28))}<small>${esc(post.time || scheduleLabel(post))}</small></span></div>`).join("")}</div>`;
  }
  $("#calendar").innerHTML = html;
  $$("[data-open]").forEach(node => node.onclick = () => openPost(node.dataset.open));
}
function renderLibrary() {
  const items = future().filter(post => libraryFilter === "all" || post.status === libraryFilter || post.approval === libraryFilter);
  $("#library").innerHTML = items.length
    ? items.map(post => `<article class="library-card" data-open="${post.id}"><img src="${post.image}"><div class="library-info"><b>${esc(post.notes || post.caption || "Untitled content")}</b><span>${esc(`${post.type} · ${formatSchedule(post)} · ${post.approval}`)}</span></div></article>`).join("")
    : `<div class="empty">No content in this view yet.</div>`;
  $$("[data-open]").forEach(node => node.onclick = () => openPost(node.dataset.open));
}
function renderApprovals() {
  const columns = [["draft", "Draft"], ["needs-review", "Needs Review"], ["approved", "Approved"]];
  $("#approvalBoard").innerHTML = columns.map(([key, label]) => `<section class="approval-col"><h4>${label}</h4>${future().filter(post => post.approval === key).map(post => `<article class="approval-card" data-open="${post.id}"><img src="${post.image}"><b>${esc(post.notes || post.caption || post.type)}</b><span>${esc(formatSchedule(post))}</span></article>`).join("") || `<div class="empty">Nothing here.</div>`}</section>`).join("");
  $$("[data-open]").forEach(node => node.onclick = () => openPost(node.dataset.open));
}
function openPost(id) {
  selected = id;
  switchView("grid");
  renderGrid();
  renderInspector();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function switchView(name) {
  currentView = name;
  $$(".view").forEach(view => view.classList.add("hidden"));
  $(`#view-${name}`).classList.remove("hidden");
  $$(".nav").forEach(nav => nav.classList.toggle("active", nav.dataset.view === name));
  $("#pageTitle").textContent = { grid: "Grid Planner", calendar: "Calendar", library: "Content Library", approvals: "Approvals" }[name];
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
  const oversized = files.filter(file => file.size > 8 * 1024 * 1024);
  if (oversized.length) notify("Images over 8 MB were skipped");
  for (const file of files.filter(file => file.size <= 8 * 1024 * 1024)) {
    posts.unshift({
      id: crypto.randomUUID(),
      image: await readFile(file),
      status: "draft",
      approval: "draft",
      type: "IMAGE",
      date: "",
      time: "",
      scheduleState: "draft",
      caption: "",
      notes: "",
      comments: [],
      updatedBy: currentUser.name,
      updatedAt: new Date().toISOString()
    });
  }
  renderAll();
  event.target.value = "";
  await persistPlanner("added new content");
  notify("Content added");
};
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

async function checkInstagram() {
  try {
    igStatus = await api("/api/instagram/status");
    const connected = igStatus.connected;
    $("#connectionDot").classList.toggle("on", connected);
    $("#sideStatus").textContent = connected ? `Connected as @${igStatus.profile?.username || "Instagram"}` : (igStatus.configured ? "Ready to connect" : "Meta setup needed");
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
    $("#sideStatus").textContent = "Local server issue";
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
window.addEventListener("focus", () => { refreshSharedPlanner(); checkInstagram(); });

$("#syncBtn").onclick = syncInstagram;
$("#modalSync").onclick = syncInstagram;
$("#settingsBtn").onclick = () => { $("#settingsModal").classList.remove("hidden"); renderSettings(); };
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
  currentUser = { name, role };
  saveUser();
  $("#identityModal").classList.add("hidden");
  await loadPlanner();
  renderAll();
  notify("Identity updated");
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
  await loadPlanner();
  renderAll();
  await checkInstagram();
  if (igStatus.connected && !initialInstagramSyncDone) {
    initialInstagramSyncDone = true;
    await syncInstagram({silent: true});
  }
}

init().catch(error => {
  notify(error.message || "Planner failed to load");
});
