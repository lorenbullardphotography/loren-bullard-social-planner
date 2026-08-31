const USER_KEY = "lb-content-planner-user-v1";
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
let selected = null, dragId = null, currentView = "grid", libraryFilter = "all", librarySearch = "";
let settings = { pillars: [], formats: ["IMAGE", "REEL", "CAROUSEL"], goals: [], syncPhotoCount: 12 };
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
const CHECKLIST = ["Select assets", "Write caption", "Add hashtags", "Choose audio / cover", "Review", "Approve", "Schedule in Meta", "Confirm published"];
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
function checklistFor(post) {
  if (Array.isArray(post.checklist) && post.checklist.length) return post.checklist;
  return CHECKLIST.map(label => ({ label, done: false }));
}
function isOverdue(post) {
  return Boolean(post.dueDate && post.dueDate < new Date().toISOString().slice(0, 10) && !["published", "archived"].includes(workflowOf(post)));
}
function setPlanner(data) {
  posts = Array.isArray(data?.posts) ? data.posts : [];
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
  renderInspector();
  if (currentView === "editor") renderInspector("#postEditor");
  renderCalendar();
  renderLibrary();
  renderApprovals();
  renderTeam();
  renderActivity();
  renderPlannerSettings();
}
function assetPreview(post) {
  return post.assetKind === "video"
    ? '<video src="' + esc(post.image) + '" controls muted playsinline></video>'
    : '<img src="' + esc(post.image) + '" alt="">';
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
    if (post.assetKind === "video" || post.type === "REEL" && /\.((mp4)|(mov)|(webm))($|\?)/i.test(post.image)) {
      const video = document.createElement("video");
      video.src = post.image;
      video.muted = true;
      video.loop = true;
      video.autoplay = true;
      video.playsInline = true;
      video.className = "tile-media";
      node.querySelector("img").replaceWith(video);
    } else node.querySelector("img").src = post.image;
    node.querySelector(".tag").textContent = post.status === "posted" ? "LIVE" : WORKFLOW_LABELS[workflowOf(post)];
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
function renderInspector(hostSelector = "#inspector") {
  const host = $(hostSelector);
  const post = posts.find(item => item.id === selected);
  if (!post) {
    host.innerHTML = `<div class="inspector-empty"><b>Select a post</b>Click a tile to edit its caption, date, notes, approval, or scheduling.</div>`;
    return;
  }
  if (post.status === "posted") {
    host.innerHTML = `<div class="editor">
      <div class="preview-wrap">${assetPreview(post)}</div>
      <div class="posted-lock">This post is live on Instagram and stays locked in the grid.<br><br><b>${post.timestamp ? new Date(post.timestamp).toLocaleDateString() : "Posted"}</b>${post.permalink ? ` · <a href="${esc(post.permalink)}" target="_blank" rel="noopener noreferrer">Open on Instagram</a>` : ""}<br>${esc(formatSchedule(post))}</div>
      <label class="field">Caption<textarea rows="8" readonly>${esc(post.caption || "")}</textarea></label>
    </div>`;
    return;
  }
  const comments = (post.comments || []).map(comment => `<div class="comment"><b>${esc(comment.author)}${comment.role ? ` · ${esc(comment.role)}` : ""}</b>${esc(comment.text)}</div>`).join("");
  const workflowOptions = Object.entries(WORKFLOW_LABELS).map(([key, label]) => `<option value="${key}" ${workflowOf(post) === key ? "selected" : ""}>${label}</option>`).join("");
  const pillarOptions = `<option value="">Choose a pillar</option>` + settings.pillars.map(pillar => `<option ${post.pillar === pillar ? "selected" : ""}>${esc(pillar)}</option>`).join("");
  const checklistHtml = checklistFor(post).map((item, index) => `<label class="check-item"><input type="checkbox" data-check="${index}" ${item.done ? "checked" : ""}><span>${esc(item.label)}</span></label>`).join("");
  host.innerHTML = `<div class="editor">
    <div class="preview-wrap">${assetPreview(post)}</div>
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
      <label class="field">Client / session<input id="eClient" value="${esc(post.client || "")}" placeholder="Optional reference"></label>
    </div>
    <div class="two">
      <label class="field">Format<select id="eType">${settings.formats.map(format => `<option ${post.type === format ? "selected" : ""}>${esc(format)}</option>`).join("")}</select></label>
      <label class="field">Publish date<input id="eDate" type="date" value="${post.date || ""}"></label>
    </div>
    <div class="two">
      <label class="field">Publish time<input id="eTime" type="time" value="${post.time || ""}"></label>
      <label class="field">Scheduling<select id="eScheduleState"><option value="draft" ${post.scheduleState === "draft" ? "selected" : ""}>Not ready</option><option value="ready" ${post.scheduleState === "ready" ? "selected" : ""}>Ready to schedule</option><option value="scheduled" ${post.scheduleState === "scheduled" ? "selected" : ""}>Scheduled</option></select></label>
    </div>
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
    <div class="field">Checklist<div class="checklist">${checklistHtml}</div></div>
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
    <div class="actions"><button id="saveEdit" class="primary">Save</button><button id="deleteEdit" class="danger">Delete</button></div>
  </div>`;
  $$("[data-ap]").forEach(button => {
    button.onclick = async () => {
      applyWorkflow(post, button.dataset.ap === "draft" ? "drafting" : button.dataset.ap);
      post.updatedBy = currentUser.name;
      post.updatedAt = new Date().toISOString();
      renderAll();
      await persistPlanner(`updated approval for ${post.type.toLowerCase()} content`);
    };
  });
  $("#saveEdit").onclick = async () => {
    post.type = $("#eType").value;
    applyWorkflow(post, $("#eWorkflow").value);
    post.assignee = $("#eAssignee").value.trim();
    post.dueDate = $("#eDueDate").value;
    post.priority = $("#ePriority").value;
    post.pillar = $("#ePillar").value;
    post.client = $("#eClient").value.trim();
    post.date = $("#eDate").value;
    post.time = $("#eTime").value;
    post.scheduleState = $("#eScheduleState").value;
    post.caption = $("#eCaption").value;
    post.notes = $("#eNotes").value;
    post.goal = $("#eGoal").value.trim();
    post.hook = $("#eHook").value.trim();
    post.cta = $("#eCta").value.trim();
    post.audio = $("#eAudio").value.trim();
    post.hashtags = $("#eHashtags").value.trim();
    post.tagNotes = $("#eTagNotes").value.trim();
    post.altText = $("#eAltText").value.trim();
    post.checklist = checklistFor(post).map((item, index) => ({ ...item, done: $(`[data-check="${index}"]`).checked }));
    post.updatedBy = currentUser.name;
    post.updatedAt = new Date().toISOString();
    renderAll();
    await persistPlanner("updated planned content");
    notify("Post updated");
  };
  $("#deleteEdit").onclick = async () => {
    const previousPosts = posts;
    const deleteButton = $("#deleteEdit");
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
  $("#copyCaption").onclick = () => copyText(post.caption, "Caption");
  $("#copyHashtags").onclick = () => copyText(post.hashtags, "Hashtags");
  $("#markMeta").onclick = async () => {
    applyWorkflow(post, "ready-meta");
    post.updatedBy = currentUser.name;
    post.updatedAt = new Date().toISOString();
    renderAll();
    await persistPlanner("marked content ready for Meta Business Suite");
    notify("Ready for Meta Business Suite");
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
  $$("[data-check]").forEach(input => input.onchange = async () => {
    post.checklist = checklistFor(post).map((item, index) => ({ ...item, done: $(`[data-check="${index}"]`).checked }));
    post.updatedBy = currentUser.name;
    post.updatedAt = new Date().toISOString();
    await persistPlanner("updated the content checklist");
    notify("Checklist updated");
  });
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
    const searchable = [post.caption, post.notes, post.pillar, post.client, post.assignee, post.goal, post.hook].join(" ").toLowerCase();
    return matchesFilter && (!query || searchable.includes(query));
  });
  $("#library").innerHTML = items.length
    ? items.map(post => `<article class="library-card" data-open="${post.id}"><img src="${post.image}"><div class="library-info"><b>${esc(post.notes || post.caption || "Untitled content")}</b><span>${esc(`${post.type} · ${formatSchedule(post)} · ${WORKFLOW_LABELS[workflowOf(post)]}${post.pillar ? ` · ${post.pillar}` : ""}`)}</span></div></article>`).join("")
    : `<div class="empty">No content in this view yet.</div>`;
  $$("[data-open]").forEach(node => node.onclick = () => openPost(node.dataset.open));
}
function renderApprovals() {
  const columns = [["drafting", "Drafting"], ["needs-review", "Needs Review"], ["approved", "Approved"], ["ready-meta", "Ready for Meta"], ["meta-scheduled", "Scheduled in Meta"]];
  $("#approvalBoard").innerHTML = columns.map(([key, label]) => `<section class="approval-col"><h4>${label}</h4>${future().filter(post => workflowOf(post) === key).map(post => `<article class="approval-card" data-open="${post.id}"><img src="${post.image}"><b>${esc(post.notes || post.caption || post.type)}</b><span>${esc(formatSchedule(post))}</span></article>`).join("") || `<div class="empty">Nothing here.</div>`}</section>`).join("");
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
  $("#pageTitle").textContent = { grid: "Grid Planner", calendar: "Calendar", library: "Content Library", approvals: "Approvals", editor: "Edit post", settings: "Settings" }[name];
  if (name === "settings") renderPlannerSettings();
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
  try {
    for (const [index, file] of validFiles.entries()) {
      uploadStatus.textContent = "Uploading " + (index + 1) + " of " + validFiles.length + "…";
      const uploaded = await api("/api/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, data: await readFile(file) }) });
      const id = crypto.randomUUID();
      firstId ||= id;
      posts.unshift({
        id,
        image: uploaded.url,
        assetKind: uploaded.kind,
        status: "draft",
        approval: "draft",
        type: uploaded.kind === "video" ? "REEL" : "IMAGE",
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
    selected = firstId;
    renderAll();
    await persistPlanner("uploaded new content");
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
setInterval(heartbeat, 20000);
window.addEventListener("focus", () => { refreshSharedPlanner(); checkInstagram(); });

$("#syncBtn").onclick = syncInstagram;
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
$("#backToGrid").onclick = () => switchView("grid");
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
