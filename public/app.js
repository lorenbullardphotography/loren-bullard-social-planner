const USER_KEY = "lb-content-planner-user-v1";
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
let selected = null, dragId = null, touchDrag = null, calendarTouch = null, suppressTileClickUntil = 0, suppressCalendarClickUntil = 0, currentView = "grid", editorReturnView = "grid", calendarView = "month", libraryFilter = "all", librarySearch = "", librarySection = "assets", taskTab = "mine", approvalDetail = null, activityFilters = null, editorDirty = false, editorSaveInProgress = false;
let settings = { pillars: [], formats: ["IMAGE", "REEL", "CAROUSEL"], goals: [], syncPhotoCount: 12, workflowAutomations: {} };
let calCursor = new Date();

const demo = (text, bg, fg = "#fff") => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="100%" height="100%" fill="${bg}"/><circle cx="500" cy="390" r="165" fill="rgba(255,255,255,.15)"/><text x="500" y="585" text-anchor="middle" font-family="Georgia" font-size="57" fill="${fg}">${text}</text></svg>`)}`;
const seed = [
  { id: crypto.randomUUID(), image: "/assets/family-films.jpg", assetSource: "uploaded", assetKind: "image", status: "planned", approval: "needs-review", type: "REEL", date: "2026-09-08", time: "09:00", scheduleState: "ready", caption: "", notes: "Use emotional family hook.", comments: [] },
  { id: crypto.randomUUID(), image: "/assets/brand-cover.jpg", assetSource: "uploaded", assetKind: "image", status: "draft", approval: "feedback", type: "IMAGE", date: "2026-09-11", time: "11:00", scheduleState: "draft", caption: "", notes: "Carousel idea: studio vs. in-home.", comments: [] },
  { id: crypto.randomUUID(), image: "/assets/couple-mug.png", assetSource: "uploaded", assetKind: "image", status: "planned", approval: "approved", type: "IMAGE", date: "2026-09-15", time: "08:30", scheduleState: "scheduled", caption: "", notes: "Sentimental motherhood caption.", comments: [] }
];

let posts = [];
let scratch = [];
let team = [];
let activity = [];
let igStatus = { connected: false };
let plannerVersion = 0;
let plannerChangeToken = 0;
let currentUser = loadUser();
const CALENDAR_INSTAGRAM_KEY = "lb-calendar-instagram-v1";
let calendarShowInstagram = loadCalendarInstagramPreference(currentUser);
let initialInstagramSyncDone = false;
let carouselSlide = 0;

async function loadAccount() {
  const data = await api("/api/auth/me");
  if (!data.user) throw new Error("Please sign in to the planner.");
  currentUser = data.user;
  calendarShowInstagram = loadCalendarInstagramPreference(currentUser);
  saveUser();
  activityFilters = loadActivityFilters(currentUser);
}

function loadUser() {
  try {
    const saved = JSON.parse(localStorage.getItem(USER_KEY));
    if (saved?.name) return { name: saved.name, role: saved.role || "Admin" };
  } catch {}
  return { name: "Loren", role: "Admin" };
}
function saveUser() {
  localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
}
function loadCalendarInstagramPreference(user) {
  return localStorage.getItem(CALENDAR_INSTAGRAM_KEY + ":" + (user?.name || "default")) !== "false";
}
function saveCalendarInstagramPreference(user, value) {
  localStorage.setItem(CALENDAR_INSTAGRAM_KEY + ":" + (user?.name || "default"), String(value));
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
function calendarPosts() {
  return calendarShowInstagram ? [...future(), ...posted()] : future();
}
function ordered() { return [...future(), ...visiblePosted()]; }
function esc(s = "") { return s.replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
function safeCanvaUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && /(^|\.)canva\.com$/i.test(url.hostname) ? url.toString() : ""; } catch { return ""; }
}
function assetKindOf(post) {
  if (post.assetKind === "video" || /\.(mp4|mov|webm|m4v)(\?|$)/i.test(post.image || "")) return "video";
  return "image";
}
function assetSourceOf(post) { return post.assetSource === "canva" || post.canvaUrl ? "canva" : "uploaded"; }
function assetTypeLabel(post) {
  if (assetKindOf(post) === "video") return "Video";
  if (assetSourceOf(post) === "canva") return post.canvaAssetType === "video" ? "Video" : "Image";
  if (post.canvaDoctypeName) return post.canvaDoctypeName;
  const labels = { doc: "Canva Doc", email: "Canva Email", presentation: "Canva Presentation", sheet: "Canva Sheet", whiteboard: "Canva Whiteboard", custom: "Canva Design", unknown: "Canva Design" };
  const type = (post.canvaDesignTypes || []).map(value => labels[value] || value).filter(Boolean)[0];
  return type || (assetSourceOf(post) === "canva" ? "Canva Design" : "Image");
}
function needsCanvaPreviewRefresh(post) {
  if (assetSourceOf(post) !== "canva") return false;
  if (!post.image || !post.canvaPreviewUpdatedAt) return true;
  try {
    const expiresAt = new URL(post.image, "https://planner.local").searchParams.get("exp");
    return expiresAt !== null && Number.isFinite(Number(expiresAt)) && Number(expiresAt) * 1000 <= Date.now();
  } catch { return false; }
}
function hasReelCover(post) { return post.type === "REEL" && Boolean(post.coverImage); }
function gridImageOf(post) { return hasReelCover(post) ? post.coverImage : post.image; }
function carouselImages(post) {
  const images = Array.isArray(post.images) ? post.images.filter(Boolean) : [];
  return images.length ? images : (post.image ? [post.image] : []);
}
function assetMediaMarkup(post, className = "") {
  return assetKindOf(post) === "video"
    ? `<video class="${className}" src="${esc(post.image)}" muted playsinline preload="metadata"></video>`
    : `<img class="${className}" src="${esc(post.image)}" alt="">`;
}
function libraryAssetBadges(post) {
  const assetKind = assetKindOf(post);
  const source = assetSourceOf(post);
  const typeLabel = assetKind === "video" ? "Video" : "Image";
  const typeIcon = assetKind === "video" ? "▶" : "▧";
  const sourceLabel = source === "canva" ? "Canva" : "Uploaded";
  const sourceIcon = source === "canva" ? "C" : "↑";
  return `<span class="asset-badge library-asset-badge" title="${typeLabel}" aria-label="${typeLabel}">${typeIcon}</span><span class="asset-badge library-asset-badge source-${source}" title="${sourceLabel}" aria-label="${sourceLabel}">${sourceIcon}</span>`;
}
function configureGridVideo(video) {
  video.muted = true;
  video.loop = false;
  video.autoplay = false;
  video.playsInline = true;
  video.preload = "metadata";
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
  "needs-review": "Needs review", feedback: "Feedback", approved: "Approved", "ready-meta": "Ready for Meta",
  "meta-scheduled": "Scheduled in Meta", published: "Published", archived: "Archived"
};
const DEFAULT_PILLARS = ["Newborn education", "Family sessions", "Motherhood", "Behind the scenes", "Client stories", "Photographer education", "Personal connection", "Offers and availability"];
function workflowOf(post) {
  if (post.status === "posted") return "published";
  if (WORKFLOW_LABELS[post.workflow]) return post.workflow;
  if (post.approval === "needs-review") return "needs-review";
  if (post.approval === "feedback") return "feedback";
  if (post.approval === "approved") return "approved";
  return post.status === "draft" ? "drafting" : "idea";
}
function applyWorkflow(post, workflow) {
  post.workflow = workflow;
  post.status = workflow === "published" ? "posted" : ["approved", "ready-meta", "meta-scheduled"].includes(workflow) ? "planned" : "draft";
  post.approval = workflow === "needs-review" ? "needs-review" : workflow === "feedback" ? "feedback" : workflow === "approved" || workflow === "ready-meta" || workflow === "meta-scheduled" || workflow === "published" ? "approved" : "feedback";
  const automaticAssignee = settings.workflowAutomations?.[workflow];
  if (automaticAssignee) post.assignee = automaticAssignee;
}
function workflowPill(workflow) {
  return `<span class="workflow-pill" data-workflow="${esc(workflow)}">${esc(WORKFLOW_LABELS[workflow] || workflow)}</span>`;
}
function isOverdue(post) {
  return Boolean(post.dueDate && post.dueDate < new Date().toISOString().slice(0, 10) && !["published", "archived"].includes(workflowOf(post)));
}
function taskPosts(sourcePosts, user, tab = "mine", sort = "priority") {
  return sourcePosts.filter(post => {
    if (post.status === "posted" || workflowOf(post) === "archived") return false;
    const actionable = isOverdue(post) || workflowOf(post) === "needs-review" || workflowOf(post) === "ready-meta" || Boolean(post.assignee);
    return actionable && (tab === "team" || post.assignee === user?.name);
  }).sort((a, b) => {
    if (sort === "activity") return (b.updatedAt || "").localeCompare(a.updatedAt || "");
    if (sort === "due") return (a.dueDate || "9999").localeCompare(b.dueDate || "9999");
    const rank = post => isOverdue(post) ? 0 : workflowOf(post) === "needs-review" ? 1 : workflowOf(post) === "ready-meta" ? 2 : 3;
    return rank(a) - rank(b) || (a.dueDate || "9999").localeCompare(b.dueDate || "9999");
  });
}
const APPROVAL_COLUMNS = [["drafting", "Drafting"], ["needs-review", "Needs Review"], ["feedback", "Feedback"], ["approved", "Approved"], ["ready-meta", "Ready for Meta"], ["meta-scheduled", "Scheduled in Meta"]];
function approvalSections(sourcePosts) {
  return APPROVAL_COLUMNS.map(([key, label]) => {
    const grouped = sourcePosts.filter(post => post.status !== "posted" && workflowOf(post) === key);
    return { key, label, posts: grouped, count: grouped.length, remaining: Math.max(0, grouped.length - 1) };
  });
}
function activityType(item) {
  if (item.type) return item.type;
  const text = String(item.text || "").toLowerCase();
  if (/approv|review/.test(text)) return "approval";
  if (/sync/.test(text)) return "sync";
  if (/comment/.test(text)) return "comment";
  if (/setting|profile/.test(text)) return "settings";
  if (/upload|asset|content|post|idea/.test(text)) return "content";
  return "update";
}
function filterActivity(items, type = "all") {
  const types = Array.isArray(type) ? type : type === "all" ? null : [type];
  return items.filter(item => !types || types.includes(activityType(item))).sort((a, b) => (b.at || "").localeCompare(a.at || ""));
}
const ACTIVITY_LABELS = { approval: "Approval", content: "Content", sync: "Sync", comment: "Comment", settings: "Settings", update: "Update" };
function activityLabel(type) { return ACTIVITY_LABELS[type] || "Update"; }
const ACTIVITY_FILTER_TYPES = Object.keys(ACTIVITY_LABELS);
function activityFilterStorageKey(user) { return `lb-activity-filters-v1-${encodeURIComponent((user?.name || "").trim().toLowerCase())}`; }
function loadActivityFilters(user, storage = localStorage) {
  const raw = storage.getItem(activityFilterStorageKey(user));
  if (raw === null) return [...ACTIVITY_FILTER_TYPES];
  try { return ACTIVITY_FILTER_TYPES.filter(type => JSON.parse(raw).includes(type)); } catch { return [...ACTIVITY_FILTER_TYPES]; }
}
function saveActivityFilters(user, filters, storage = localStorage) {
  storage.setItem(activityFilterStorageKey(user), JSON.stringify(ACTIVITY_FILTER_TYPES.filter(type => filters.includes(type))));
}
function personInitials(name = "") {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join("");
}
function assigneePeople(user, members = [], selected = "") {
  const people = [user, ...members, selected ? { name: selected, role: "Teammate" } : null].filter(person => person?.name);
  const seen = new Set();
  return people.filter(person => {
    const key = person.name.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
let scratchAttachedImages = [];
function formatIdeaTimestamp(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function scratchIdeaPayload(values) {
  const rawImages = Array.isArray(values.images)
    ? values.images
    : (values.images ? [values.images] : []);
  const singleImage = String(values.image || "").trim();
  const allImages = [...new Set([...rawImages.map(img => String(img).trim()), singleImage].filter(Boolean))];
  return {
    title: String(values.title || "").trim(),
    body: String(values.body || "").trim(),
    image: allImages[0] || singleImage,
    images: allImages,
    format: String(values.format || "").trim(),
    pillar: String(values.pillar || "").trim(),
    tags: String(values.tags || "").split(",").map(tag => tag.trim().replace(/^#/, "")).filter(Boolean),
    goal: String(values.goal || "").trim(),
    hook: String(values.hook || "").trim(),
    cta: String(values.cta || "").trim(),
    comments: Array.isArray(values.comments) ? values.comments : []
  };
}
function renderScratchPhotosTray() {
  const tray = $("#scratchPhotosTray");
  if (!tray) return;
  tray.innerHTML = scratchAttachedImages.map((url, idx) => `
    <div class="scratch-photo-thumb">
      <img src="${esc(url)}" alt="Attached photo">
      <button type="button" class="scratch-photo-remove" data-photo-idx="${idx}" title="Remove photo">×</button>
    </div>
  `).join("");
  $$(".scratch-photo-remove").forEach(btn => {
    btn.onclick = () => {
      const idx = Number(btn.dataset.photoIdx);
      scratchAttachedImages.splice(idx, 1);
      renderScratchPhotosTray();
    };
  });
}
function populateScratchSelects() {
  const formatEl = $("#scratchFormat");
  const pillarEl = $("#scratchPillar");
  if (formatEl) {
    const currentVal = formatEl.value;
    const formats = (settings?.formats && settings.formats.length) ? settings.formats : ["IMAGE", "REEL", "CAROUSEL"];
    formatEl.innerHTML = '<option value="">Choose a format</option>' + formats.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join("");
    if (currentVal) formatEl.value = currentVal;
  }
  if (pillarEl) {
    const currentVal = pillarEl.value;
    const pillars = (settings?.pillars && settings.pillars.length) ? settings.pillars : DEFAULT_PILLARS;
    pillarEl.innerHTML = '<option value="">Choose a pillar</option>' + pillars.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
    if (currentVal) pillarEl.value = currentVal;
  }
}
function normalizeActivityText(text = "") {
  return String(text || "")
    .replace(/a\s+Scratch\s+Book\s+idea/gi, "an idea")
    .replace(/Scratch\s+Book\s+idea/gi, "idea")
    .replace(/saved\s+to\s+Scratch\s+Book/gi, "saved an idea")
    .replace(/Scratch\s+Book/gi, "idea")
    .replace(/\b(?:a|an)\s+(?:idea\s+idea|Idea\s+idea)\b/gi, "an idea")
    .replace(/\ba\s+idea\b/gi, "an idea");
}
function setPlanner(data) {
  isPlannerLoaded = true;
  posts = (Array.isArray(data?.posts) ? data.posts : []).map(post => ({ ...post, assetKind: assetKindOf(post), assetSource: assetSourceOf(post) }));
  scratch = Array.isArray(data?.scratch) ? data.scratch : [];
  team = Array.isArray(data?.team) ? data.team : [];
  activity = (Array.isArray(data?.activity) ? data.activity : []).map(item => ({ ...item, text: normalizeActivityText(item?.text) }));
  settings = { pillars: DEFAULT_PILLARS, formats: ["IMAGE", "REEL", "CAROUSEL"], goals: ["Educate", "Connect", "Showcase work", "Book sessions", "Build trust"], syncPhotoCount: 12, workflowAutomations: {}, ...(data?.settings || {}) };
  plannerVersion = Number(data?.version || 0);
  if (selected && !posts.find(post => post.id === selected)) selected = null;
  populateScratchSelects();
}

let isPlannerLoaded = false;
let isPlannerLoading = false;

function setPageLoading(isLoading) {
  isPlannerLoading = Boolean(isLoading);
  const bar = $("#pageLoadingBar");
  if (bar) bar.classList.toggle("active", isPlannerLoading);
}

function renderTasksSkeleton() {
  const host = $("#taskList");
  if (!host) return;
  host.innerHTML = Array.from({ length: 4 }).map(() => `
    <article class="skeleton-task-card" aria-hidden="true">
      <div class="skeleton-task-thumb skeleton"></div>
      <div class="skeleton-task-info">
        <div class="skeleton skeleton-pill"></div>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-line short"></div>
      </div>
    </article>
  `).join("");
}

function renderApprovalsSkeleton() {
  const host = $("#approvalPanel");
  if (!host) return;
  host.innerHTML = `
    <div class="approval-board" aria-hidden="true">
      ${Array.from({ length: 3 }).map(() => `
        <div class="approval-col">
          <div class="skeleton skeleton-line" style="height:20px;width:120px;margin-bottom:12px"></div>
          <div class="skeleton-task-card">
            <div class="skeleton-task-thumb skeleton"></div>
            <div class="skeleton-task-info">
              <div class="skeleton skeleton-pill"></div>
              <div class="skeleton skeleton-line"></div>
            </div>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderActivitySkeleton() {
  const host = $("#activityList");
  if (!host) return;
  host.innerHTML = Array.from({ length: 5 }).map(() => `
    <div class="activity-item skeleton-card" aria-hidden="true">
      <div class="skeleton skeleton-line" style="width:100px;height:10px"></div>
      <div class="skeleton skeleton-line" style="width:90%"></div>
    </div>
  `).join("");
}

function renderGridSkeleton() {
  const host = $("#grid");
  if (!host) return;
  host.innerHTML = Array.from({ length: 9 }).map(() => `
    <div class="skeleton-tile skeleton" aria-hidden="true"></div>
  `).join("");
}

function renderCalendarSkeleton() {
  const host = $("#calendar");
  const agendaHost = $("#calendarAgenda");
  if (host) {
    host.innerHTML = `
      <div class="cal-head">Sun</div><div class="cal-head">Mon</div><div class="cal-head">Tue</div><div class="cal-head">Wed</div><div class="cal-head">Thu</div><div class="cal-head">Fri</div><div class="cal-head">Sat</div>
      ${Array.from({ length: 14 }).map(() => `
        <div class="skeleton-day" aria-hidden="true">
          <div class="skeleton skeleton-line short" style="width:20px;height:12px"></div>
          <div class="skeleton skeleton-line" style="height:24px;border-radius:6px"></div>
        </div>
      `).join("")}
    `;
  }
  if (agendaHost) {
    agendaHost.innerHTML = Array.from({ length: 3 }).map(() => `
      <div class="skeleton-agenda-card" aria-hidden="true">
        <div class="skeleton skeleton-line" style="height:40px;border-radius:8px"></div>
        <div class="skeleton skeleton-line" style="height:40px;border-radius:8px"></div>
      </div>
    `).join("");
  }
}

function renderLibrarySkeleton() {
  const host = $("#library");
  const scratchHost = $("#scratchList");
  if (host) {
    host.innerHTML = Array.from({ length: 8 }).map(() => `
      <div class="skeleton-library-card" aria-hidden="true">
        <div class="skeleton-library-thumb skeleton"></div>
        <div class="skeleton-library-info">
          <div class="skeleton skeleton-line" style="width:70%"></div>
          <div class="skeleton skeleton-line short"></div>
        </div>
      </div>
    `).join("");
  }
  if (scratchHost) {
    scratchHost.innerHTML = Array.from({ length: 3 }).map(() => `
      <div class="skeleton-card" aria-hidden="true">
        <div class="skeleton skeleton-line" style="width:50%;height:16px"></div>
        <div class="skeleton skeleton-line" style="width:100%;height:40px"></div>
      </div>
    `).join("");
  }
}

function renderEditorSkeleton() {
  const host = $("#postEditor");
  if (!host) return;
  host.innerHTML = `
    <div class="editor" aria-hidden="true">
      <div class="preview-wrap skeleton" style="aspect-ratio:16/9;width:100%;min-height:220px"></div>
      <div class="skeleton skeleton-line" style="height:36px;border-radius:9px;margin-top:10px"></div>
      <div class="skeleton skeleton-line" style="height:70px;border-radius:9px"></div>
    </div>
  `;
}

function renderSettingsSkeleton() {
  const automations = $("#workflowAutomations");
  if (automations) {
    automations.innerHTML = Array.from({ length: 4 }).map(() => `
      <div class="automation-row" aria-hidden="true">
        <div class="skeleton skeleton-line" style="width:120px;height:14px"></div>
        <div class="skeleton skeleton-pill" style="width:140px;height:30px"></div>
      </div>
    `).join("");
  }
}

function renderAllSkeletons() {
  renderTasksSkeleton();
  renderApprovalsSkeleton();
  renderActivitySkeleton();
  renderGridSkeleton();
  renderCalendarSkeleton();
  renderLibrarySkeleton();
  renderSettingsSkeleton();
  if (currentView === "editor") renderEditorSkeleton();
}


async function api(path, options) {
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error("Could not reach the planner server. Please refresh and try again.");
  }
  // Some hosts (notably Vercel) return an HTML error page when the request
  // exceeds their function body limit. Calling response.json() on that page
  // produces Safari's unhelpful "The string did not match the expected
  // pattern" error, hiding the actual upload problem.
  const responseText = await response.text();
  let data = {};
  try { data = responseText ? JSON.parse(responseText) : {}; } catch {
    if (!response.ok && response.status === 413) {
      throw new Error("This asset is too large for the upload connection. Try a smaller image or video.");
    }
    if (!response.ok) throw new Error(`Upload failed (server returned ${response.status}).`);
    throw new Error("The server returned an unreadable response. Please try again.");
  }
  if (!response.ok) {
    const error = new Error(data.error || "Request failed");
    error.status = response.status;
    error.code = data.code;
    error.planner = data.planner;
    error.asset = data.asset;
    error.conflicts = data.conflicts;
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
}
function shouldRefreshPlanner({ currentView, editorDirty, editorSaveInProgress }) {
  return currentView !== "editor" || (!editorDirty && !editorSaveInProgress);
}
function editorDestinationAfterSave(currentView, editorReturnView) {
  return currentView === "editor" ? editorReturnView : currentView;
}
const ASSET_EDIT_FIELDS = ["type", "workflow", "status", "approval", "assignee", "priority", "pillar", "date", "scheduleState", "caption", "notes", "audio", "hashtags", "tagNotes", "altText", "location", "locationTag", "cropZoom", "cropX", "cropY", "comments", "coverImage", "image", "images", "assetKind", "canvaAssetType", "canvaPreviewUpdatedAt"];
let currentEditorBaseline = null;
let editorConflictState = null;

function mergeAssetEdit(latestPost, editedPost) {
  const edit = {};
  for (const field of ASSET_EDIT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(editedPost, field)) edit[field] = editedPost[field];
  }
  return { ...latestPost, ...edit };
}

function assetEditorBaseline(post) {
  return {
    revision: post?.revision || 1,
    values: Object.fromEntries(ASSET_EDIT_FIELDS.map(field => [field, post?.[field]]))
  };
}

function assetEditorChanges(baseline, edited) {
  return Object.fromEntries(ASSET_EDIT_FIELDS
    .filter(field => JSON.stringify(baseline?.values?.[field] ?? "") !== JSON.stringify(edited?.[field] ?? ""))
    .map(field => [field, edited[field]]));
}

function replaceAsset(postsList, savedAsset) {
  const normalized = { ...savedAsset, assetKind: assetKindOf(savedAsset), assetSource: assetSourceOf(savedAsset) };
  return (postsList || []).map(post => post.id === savedAsset.id ? normalized : post);
}

function mergeFreshAssets(localPosts = [], latestPosts = [], { preserveMissing = true } = {}) {
  const localById = new Map(localPosts.map(post => [post.id, post]));
  const merged = latestPosts.map(latestPost => {
    const localPost = localById.get(latestPost.id);
    return !localPost || Number(latestPost.revision || 1) > Number(localPost.revision || 1) ? latestPost : localPost;
  });
  const latestIds = new Set(latestPosts.map(post => post.id));
  return preserveMissing ? [...merged, ...localPosts.filter(post => !latestIds.has(post.id))] : merged;
}

async function saveQuickAssetChanges(post, changes, reason) {
  try {
    const result = await api(`/api/assets/${post.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: post.revision || 1, changes, actor: currentUser, reason })
    });
    posts = replaceAsset(posts, result.asset);
    selected = result.asset.id;
    currentEditorBaseline = { id: result.asset.id, ...assetEditorBaseline(result.asset) };
    return result.asset;
  } catch (error) {
    if (error.status === 409 && error.asset) {
      posts = replaceAsset(posts, error.asset);
      currentEditorBaseline = { id: error.asset.id, ...assetEditorBaseline(error.asset) };
      renderAll();
      notify("This asset changed while you were editing it. Review the latest version and try again.");
    } else {
      notify(error.message || "The asset could not be saved");
    }
    return null;
  }
}

function removeConflictField(changes = {}, field) {
  const next = { ...changes };
  delete next[field];
  return next;
}

function forceConflictField(forceFields = [], field) {
  return [...new Set([...forceFields, field])];
}
function canShowAddActions(view) {
  return ["grid", "calendar", "library"].includes(view);
}
function syncTopActions(view) {
  const visible = canShowAddActions(view);
  [$("#addCanvaBtn"), $("#addAssetLabel")].forEach(action => {
    if (!action) return;
    action.classList.toggle("hidden", !visible);
    action.setAttribute("aria-hidden", String(!visible));
  });
}
async function fetchPlannerChanges(since) {
  const response = await fetch(`/api/planner/changes?since=${since}`);
  if (response.status === 304) return { status: 304 };
  if (response.status === 503) return { status: 503 };
  if (!response.ok) throw new Error("Could not check for planner updates.");
  return { status: 200, data: await response.json() };
}

// Applies a row-storage change-feed batch (see fetchPlannerChanges) to local
// state. If the currently-selected asset has unsaved local edits, its delta
// is deliberately skipped — the draft is kept and the user gets a
// non-blocking notice instead of losing typed work — every other changed
// item is applied directly.
function applyPlannerDelta(delta) {
  if (!delta || !Array.isArray(delta.changes)) return;
  let changed = false;
  for (const change of delta.changes) {
    if (change.entityType === "asset") {
      if (change.entityId === selected && editorDirty) {
        notify("A teammate saved changes to this asset. Your draft is kept — refresh to see the latest.");
        continue;
      }
      const exists = posts.some(post => post.id === change.entityId);
      if (change.deleted) {
        if (exists) { posts = posts.filter(post => post.id !== change.entityId); changed = true; }
        if (selected === change.entityId) selected = null;
      } else {
        const normalized = { ...change.data, assetKind: assetKindOf(change.data), assetSource: assetSourceOf(change.data) };
        posts = exists ? replaceAsset(posts, normalized) : [normalized, ...posts];
        changed = true;
      }
    } else if (change.entityType === "idea") {
      const exists = scratch.some(entry => entry.id === change.entityId);
      if (change.deleted) {
        if (exists) { scratch = scratch.filter(entry => entry.id !== change.entityId); changed = true; }
      } else {
        scratch = exists ? scratch.map(entry => entry.id === change.entityId ? change.data : entry) : [change.data, ...scratch];
        changed = true;
      }
    } else if (change.entityType === "settings" && change.data) {
      settings = { ...settings, ...change.data };
      changed = true;
    }
  }
  if (Number.isFinite(delta.nextToken)) plannerChangeToken = delta.nextToken;
  if (changed) renderAll();
}

// Returns "delta" | "fallback" | "skipped" so the poll scheduler (below) can
// pick the right cadence: cheap delta polling can safely run every 5
// seconds, but the legacy whole-document fallback must stay throttled to
// the slower interval Fast Origin Transfer usage previously required —
// otherwise turning row storage off (or not yet on, which is production's
// state until Task 9) would silently reintroduce that overage at 5s instead
// of the 30s it was fixed at.
async function refreshSharedPlanner() {
  if (!shouldRefreshPlanner({ currentView, editorDirty, editorSaveInProgress })) return "skipped";
  try {
    const result = await fetchPlannerChanges(plannerChangeToken);
    if (result.status === 304) return "delta";
    if (result.status === 200) { applyPlannerDelta(result.data); return "delta"; }

    // status 503: row storage isn't enabled in this environment — fall back
    // to the legacy whole-document poll (unchanged from before Task 7,
    // minus presence).
    const latest = await api("/api/planner");
    const hasNewerPlanner = Number(latest?.version || 0) > plannerVersion;
    const mergedPosts = mergeFreshAssets(posts, latest.posts || [], { preserveMissing: !hasNewerPlanner });
    const hasNewerAssets = mergedPosts.some((post, index) => post !== posts[index]) || mergedPosts.length !== posts.length;
    if (hasNewerPlanner) {
      setPlanner({ ...latest, posts: mergedPosts });
      renderAll();
    } else if (hasNewerAssets) {
      posts = mergedPosts;
      renderAll();
    }
    return "fallback";
  } catch {
    return "fallback";
  }
}
// Row storage (assets/ideas/settings as independent rows instead of one
// whole-document save) is opt-in server-side via PLANNER_ROW_STORAGE_ENABLED.
// Every narrow-endpoint call site below tries the narrow endpoint first and
// falls back to the legacy persistPlanner() whole-document save on a 503
// (the response when the flag is off, which is production's state until
// Task 9 activates it) — so this keeps working unchanged today and needs no
// further client changes once the flag flips on. Any other failure is
// re-thrown for the caller's existing try/catch to revert optimistic state
// and notify, exactly as it already does for persistPlanner failures.
async function narrowOrFallback(action) {
  try {
    return { fallback: false, data: await action() };
  } catch (error) {
    if (error.status === 503) return { fallback: true };
    throw error;
  }
}

async function saveIdea(entry, changes, reason) {
  const result = await narrowOrFallback(() => api(`/api/ideas/${encodeURIComponent(entry.id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: entry.revision || 1, changes, actor: currentUser, reason })
  }));
  if (result.fallback) return persistPlanner(reason);
  Object.assign(entry, result.data.idea);
  entry.revision = result.data.revision;
}

async function deleteIdeaNarrow(id, reason) {
  const result = await narrowOrFallback(() => api(`/api/ideas/${encodeURIComponent(id)}`, {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actor: currentUser, reason })
  }));
  if (result.fallback) await persistPlanner(reason);
}

async function persistPlanner(reason) {
  try {
    const saved = await api("/api/planner", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: plannerVersion, posts, scratch, settings, actor: currentUser, reason })
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
  downloadFile('loren-content-planner-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify({ exportedAt: new Date().toISOString(), posts, scratch }, null, 2), "application/json");
  notify("Backup exported");
}
function approvedForMeta(post) {
  return post?.approval === "approved" || ["approved", "ready-meta", "meta-scheduled"].includes(workflowOf(post));
}
function metaExportData(post) {
  return {
    exportedAt: new Date().toISOString(),
    source: "Loren Bullard Content Planner",
    posts: [{
      id: post.id,
      mediaUrl: post.image,
      mediaType: assetKindOf(post),
      format: post.type,
      caption: post.caption || "",
      hashtags: post.hashtags || "",
      scheduledDate: post.date || "",
      scheduledTime: post.time || "",
      location: post.location || post.locationTag?.name || "",
      altText: post.altText || "",
      notes: post.notes || "",
      audio: post.audio || "",
      taggingNotes: post.tagNotes || "",
      tags: Array.isArray(post.tags) ? post.tags : [],
      coverImageUrl: post.coverImage || ""
    }]
  };
}
async function downloadAsset(post) {
  try {
    const response = await fetch(post.image);
    if (!response.ok) throw new Error("The media file could not be downloaded");
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    const sourceExtension = post.image.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i)?.[1]?.toLowerCase();
    const extension = sourceExtension || (assetKindOf(post) === "video" ? "mp4" : "jpg");
    link.download = `loren-${post.type.toLowerCase()}-${post.id}.${extension}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    notify("Approved media downloaded");
  } catch (error) {
    notify(error.message || "Media download failed");
  }
}
function exportMetaData(post) {
  if (!approvedForMeta(post)) return notify("Approve this asset before exporting it for Meta");
  downloadFile(`meta-handoff-${post.id}.json`, JSON.stringify(metaExportData(post), null, 2), "application/json");
  notify("Meta handoff data exported");
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
  if (!Array.isArray(data)) scratch = Array.isArray(data.scratch) ? data.scratch : scratch;
  renderAll();
  await persistPlanner("restored a planner backup");
  notify("Backup restored");
}

function renderAll() {
  syncTopActions(currentView);
  renderStats();
  renderTasks();
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
  renderScratch();
  renderApprovals();
  renderTeam();
  renderActivity();
  renderPlannerSettings();
}
function assetPreview(post, lockCrop = false) {
  const mediaKind = assetKindOf(post);
  const ratio = post.cropRatio || (mediaKind === "video" ? "9:16" : "4:5");
  const ratioValue = ratio === "1:1" ? "1 / 1" : ratio === "4:5" ? "4 / 5" : ratio === "1.91:1" ? "1.91 / 1" : "9 / 16";
  const zoom = lockCrop ? 1 : Math.max(1, Number(post.cropZoom) || 1);
  const x = lockCrop ? 50 : cropCoordinate(post.cropX);
  const y = lockCrop ? 50 : cropCoordinate(post.cropY);
  return mediaKind === "video"
    ? '<video class="crop-media" style="aspect-ratio:' + ratioValue + ';transform:translate(' + ((x - 50) * (zoom - 1)) + '%,' + ((y - 50) * (zoom - 1)) + '%) scale(' + zoom + ')" src="' + esc(post.image) + '" controls playsinline preload="metadata"></video>'
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
function contentBriefMarkup(post) {
  return `<div class="field">Content brief
      <label class="field nested">Audio<input id="eAudio" value="${esc(post.audio || "")}" placeholder="Audio or sound"></label>
      <label class="field nested">Hashtags<textarea id="eHashtags" rows="2" placeholder="#northwestarkansas #newbornphotographer">${esc(post.hashtags || "")}</textarea></label>
      <label class="field nested">Tagging notes<input id="eTagNotes" value="${esc(post.tagNotes || "")}" placeholder="People, vendors, collaborators"></label>
      <label class="field nested">Alt text<textarea id="eAltText" rows="2" placeholder="Describe the image for accessibility">${esc(post.altText || "")}</textarea></label>
    </div>`;
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
  const automationHost = $("#workflowAutomations");
  if (automationHost) {
    const people = assigneePeople(currentUser, team);
    automationHost.innerHTML = Object.entries(WORKFLOW_LABELS).filter(([workflow]) => !["published", "archived"].includes(workflow)).map(([workflow, label]) => `<label class="automation-row"><span><b>${esc(label)}</b><small>Automatically assign when a post enters this workflow.</small></span><select data-automation-workflow="${workflow}"><option value="">No automatic assignment</option>${people.map(person => `<option value="${esc(person.name)}" ${settings.workflowAutomations?.[workflow] === person.name ? "selected" : ""}>${esc(person.name)}</option>`).join("")}</select></label>`).join("");
  }
  const connected = igStatus.connected;
  $("#settingsConnection").innerHTML = connected ? "<b>Connected ✓</b><br>@" + esc(igStatus.profile?.username || "lorenbullardphotography") + " · " + (igStatus.profile?.media_count ?? "—") + " published items" : "<b>Instagram not connected</b><br>Connect it to sync live posts into the shared planner.";
  $("#settingsConnectLink").classList.toggle("hidden", connected);
  $("#settingsSync").classList.toggle("hidden", !connected);
  $("#settingsDisconnect").classList.toggle("hidden", !connected);
  $("#accountSettingsName").value = currentUser.name;
  $("#accountSettingsRole").value = currentUser.role;
  refreshStorageUsage();
  refreshCanvaStatus();
  loadTeamMembers().then(renderTeamSettings);
}
let teamMembers = [];
async function loadTeamMembers() {
  try {
    const data = await api("/api/team/members");
    teamMembers = Array.isArray(data.members) ? data.members : [];
  } catch {
    teamMembers = [];
  }
}
function renderTeamSettings() {
  const host = $("#teamMemberList");
  if (!host) return;
  if (!teamMembers.length) {
    host.innerHTML = '<div class="empty">No team members loaded.</div>';
    return;
  }
  host.innerHTML = teamMembers.map(member => {
    const isCurrent = currentUser && (member.id === currentUser.id || member.name.toLowerCase() === currentUser.name.toLowerCase());
    return `
      <div class="team-member-card" data-member-id="${esc(member.id)}">
        <div class="team-member-info">
          <span class="person-avatar">${esc(personInitials(member.name))}</span>
          <div class="team-member-meta">
            <b>${esc(member.name)} ${isCurrent ? '<span class="team-member-you">(You)</span>' : ''}</b>
            <small><span class="team-member-badge">${esc(member.role || "Admin")}</span></small>
          </div>
        </div>
        <div class="team-member-actions">
          <button type="button" class="ghost edit-member-btn" data-id="${esc(member.id)}" data-name="${esc(member.name)}" data-role="${esc(member.role || "Admin")}">Edit</button>
          ${!isCurrent ? `<button type="button" class="danger delete-member-btn" data-id="${esc(member.id)}" data-name="${esc(member.name)}">Remove</button>` : ''}
        </div>
      </div>
    `;
  }).join("");

  host.querySelectorAll(".edit-member-btn").forEach(btn => {
    btn.onclick = () => openTeamMemberModal({
      id: btn.dataset.id,
      name: btn.dataset.name,
      role: btn.dataset.role
    });
  });

  host.querySelectorAll(".delete-member-btn").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      if (!confirm(`Are you sure you want to remove ${name} from the team?`)) return;
      try {
        await api(`/api/team/members/${encodeURIComponent(id)}`, { method: "DELETE" });
        notify(`Removed ${name} from the team`);
        await loadPlanner();
        await loadTeamMembers();
        renderTeamSettings();
        renderAll();
      } catch (error) {
        notify(error.message);
      }
    };
  });
}
function openTeamMemberModal(member = null) {
  const modal = $("#teamMemberModal");
  if (!modal) return;
  const isEdit = Boolean(member && member.id);
  $("#teamMemberId").value = isEdit ? member.id : "";
  $("#teamMemberName").value = isEdit ? member.name : "";
  $("#teamMemberRole").value = isEdit ? (member.role || "Admin") : "Admin";
  $("#teamMemberPassword").value = "";
  $("#teamMemberModalTitle").textContent = isEdit ? "Edit team member" : "Add team member";
  $("#teamMemberModalEyebrow").textContent = isEdit ? "EDIT PROFILE" : "NEW PROFILE";
  $("#teamMemberPasswordField").querySelector("input").placeholder = isEdit ? "Leave blank to keep password" : "Minimum 8 characters";
  $("#teamMemberError").classList.add("hidden");
  $("#teamMemberError").textContent = "";
  modal.classList.remove("hidden");
  $("#teamMemberName").focus();
}
function closeTeamMemberModal() {
  const modal = $("#teamMemberModal");
  if (modal) modal.classList.add("hidden");
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
function taskReason(post) {
  return isOverdue(post) ? "Overdue" : workflowOf(post) === "needs-review" ? "Approval requested" : workflowOf(post) === "ready-meta" ? "Ready to hand off" : "Assigned to " + post.assignee;
}
function renderTasks() {
  const host = $("#taskList");
  if (!host) return;
  const sort = $("#taskSort")?.value || "priority";
  const items = taskPosts(posts, currentUser, taskTab, sort);
  const isApprovals = taskTab === "approvals";
  $("#taskList").classList.toggle("hidden", taskTab === "activity" || isApprovals);
  $("#activityPanel")?.classList.toggle("hidden", taskTab !== "activity");
  $("#approvalPanel")?.classList.toggle("hidden", !isApprovals);
  $("#taskSort")?.closest(".task-sort")?.classList.toggle("hidden", taskTab === "activity" || isApprovals);
  $("#myTasksTab")?.classList.toggle("active", taskTab === "mine");
  $("#teamTasksTab")?.classList.toggle("active", taskTab === "team");
  $("#approvalsTab")?.classList.toggle("active", isApprovals);
  $("#activityTab")?.classList.toggle("active", taskTab === "activity");
  $("#myTasksTab")?.setAttribute("aria-selected", String(taskTab === "mine"));
  $("#teamTasksTab")?.setAttribute("aria-selected", String(taskTab === "team"));
  $("#approvalsTab")?.setAttribute("aria-selected", String(isApprovals));
  $("#activityTab")?.setAttribute("aria-selected", String(taskTab === "activity"));
  if (isApprovals) { renderApprovals(); return; }
  host.innerHTML = items.length ? items.map(post => `<button class="attention-card task-card" data-open="${post.id}"><img src="${post.image}" alt=""><span><b>${esc(post.notes || post.caption || "Untitled content")}</b><small>${esc(taskReason(post))} · ${esc(post.dueDate || post.date || "No due date")}</small></span><strong class="task-assignee">${esc(post.assignee || "Unassigned")}</strong><i>›</i></button>`).join("") : `<div class="empty">No ${taskTab === "mine" ? "tasks assigned to you" : "team tasks"} right now.</div>`;
  $$("#taskList [data-open]").forEach(node => node.onclick = () => openPost(node.dataset.open, true));
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
}
function renderActivity() {
  const host = $("#activityList");
  if (!host) return;
  if (!activityFilters) activityFilters = loadActivityFilters(currentUser);
  $$("#activityFilters input").forEach(input => { input.checked = activityFilters.includes(input.value); });
  const items = filterActivity(activity, activityFilters);
  host.innerHTML = items.length
    ? items.map(item => {
      const at = new Date(item.at);
      const type = activityType(item);
      const undo = item.reversible && item.rollbackId
        ? `<button type="button" class="ghost activity-undo" data-rollback-id="${esc(item.rollbackId)}" aria-label="Undo ${esc(normalizeActivityText(item.text))}">Undo</button>`
        : "";
      return `<article class="activity-item activity-${esc(type)}"><time datetime="${esc(item.at)}">${at.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time><div><span class="activity-type activity-type-${esc(type)}">${esc(activityLabel(type))}</span><strong>${esc(normalizeActivityText(item.text))}</strong></div>${undo}</article>`;
    }).join("")
    : `<div class="empty">Shared activity will appear here as the team edits, approves, and syncs content.</div>`;
}
function renderGrid() {
  const grid = $("#grid");
  grid.innerHTML = "";
  for (const post of ordered()) {
    const node = $("#tileTpl").content.firstElementChild.cloneNode(true);
    node.dataset.id = post.id;
    node.dataset.status = post.status;
    node.dataset.workflow = workflowOf(post);
    // Use the pointer interaction below for consistent mouse, trackpad, and
    // touch behavior. Native HTML drag events are inconsistent in responsive
    // Chrome and unavailable on many mobile browsers.
    node.draggable = false;
    if (!hasReelCover(post) && (post.assetKind === "video" || post.type === "REEL" && /\.((mp4)|(mov)|(webm))($|\?)/i.test(post.image))) {
      const video = document.createElement("video");
      video.src = post.image;
      configureGridVideo(video);
      video.className = "tile-media";
      node.querySelector("img").replaceWith(video);
    } else node.querySelector("img").src = gridImageOf(post);
    const tileMedia = node.querySelector("img, video");
    if (tileMedia) tileMedia.draggable = false;
    const media = node.querySelector(".tile-media") || node.querySelector("img");
    media.classList.add("crop-rendered");
    media.style.transform = cropTransform(post);
    node.querySelector(".tag").textContent = post.status === "posted" ? "LIVE" : WORKFLOW_LABELS[workflowOf(post)];
    node.querySelector(".location-icon").classList.toggle("hidden", !post.location);
    node.querySelector(".type-icon").textContent = post.type === "REEL" ? "▶" : post.type === "CAROUSEL" ? "▱" : "";
    if (selected === post.id) node.classList.add("selected");
    const quickDelete = node.querySelector(".tile-delete");
    const quickRefresh = node.querySelector(".tile-refresh");
    const isInstagramPost = Boolean(post.metaId || post.status === "posted");
    quickDelete.classList.toggle("hidden", isInstagramPost);
    quickRefresh.classList.toggle("hidden", !needsCanvaPreviewRefresh(post) || isInstagramPost);
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
        const result = await narrowOrFallback(() => api(`/api/assets/${encodeURIComponent(post.id)}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actor: currentUser, reason: "removed a post" })
        }));
        if (result.fallback) await persistPlanner("removed a post");
        renderAll();
        notify("Post deleted from the shared planner");
      } catch (error) {
        posts = previousPosts;
        renderAll();
        notify(error.message || "The post could not be deleted");
      }
    });
    quickRefresh.addEventListener("pointerdown", event => event.stopPropagation());
    quickRefresh.addEventListener("click", event => {
      event.stopPropagation();
      refreshCanvaPreview(post, quickRefresh);
    });
    node.onclick = () => {
      if (Date.now() < suppressTileClickUntil) return;
      selected = post.id;
      renderGrid();
      renderInspector();
      if (window.matchMedia("(max-width: 700px)").matches) setGridEditorOpen(true);
    };
    node.addEventListener("selectstart", event => event.preventDefault());
    node.ondblclick = event => {
      event.preventDefault();
      if (Date.now() < suppressTileClickUntil) return;
      openPost(post.id, true);
    };
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
    // Native drag-and-drop is unavailable on most touch browsers. A short
    // long-press starts a touch reorder while a normal tap still opens edit.
    if (post.status !== "posted") {
      node.addEventListener("pointerdown", event => {
        if (!event.isPrimary || event.button !== 0) return;
        // On desktop, editing a tile should never accidentally start a reorder.
        // The drag handle is the explicit affordance for mouse and trackpad input.
        if (event.pointerType === "mouse" && !event.target.closest(".handle")) return;
        touchDrag = { id: post.id, node, x: event.clientX, y: event.clientY, moved: false, timer: null };
        const delay = event.pointerType === "mouse" ? 100 : 220;
        touchDrag.timer = setTimeout(() => {
          if (!touchDrag || touchDrag.node !== node) return;
          touchDrag.active = true;
          node.classList.add("dragging");
          node.setPointerCapture(event.pointerId);
          event.preventDefault();
        }, delay);
      });
      node.addEventListener("pointermove", event => {
        if (!touchDrag || touchDrag.node !== node) return;
        const distance = Math.hypot(event.clientX - touchDrag.x, event.clientY - touchDrag.y);
        if (!touchDrag.active) {
          if (event.pointerType === "mouse" && distance > 6) {
            clearTimeout(touchDrag.timer);
            touchDrag.active = true;
            node.classList.add("dragging");
            node.setPointerCapture(event.pointerId);
          } else if (distance > 10) clearTimeout(touchDrag.timer);
          return;
        }
        touchDrag.moved = true;
        event.preventDefault();
        $$(".tile").forEach(tile => tile.classList.remove("target"));
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".tile");
        if (target && target !== node && target.dataset.status !== "posted") target.classList.add("target");
      });
      const finishTouchDrag = async event => {
        if (!touchDrag || touchDrag.node !== node) return;
        clearTimeout(touchDrag.timer);
        const state = touchDrag;
        touchDrag = null;
        node.classList.remove("dragging");
        $$(".tile").forEach(tile => tile.classList.remove("target"));
        if (!state.active) return;
        suppressTileClickUntil = Date.now() + 450;
        event.preventDefault();
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".tile");
        if (target && target.dataset.status !== "posted") await reorder(state.id, target.dataset.id);
      };
      node.addEventListener("pointerup", finishTouchDrag);
      node.addEventListener("pointercancel", finishTouchDrag);
    }
    grid.appendChild(node);
  }
  $("#gridEmpty").classList.toggle("hidden", ordered().length > 0);
}

function setGridEditorOpen(open) {
  $("#view-grid")?.classList.toggle("grid-editor-open", Boolean(open));
}

function closeGridEditor() {
  selected = null;
  editorConflictState = null;
  setGridEditorOpen(false);
  renderGrid();
  renderInspector();
}

async function reorder(a, b) {
  if (!a || a === b) return;
  const futurePosts = future();
  const donePosts = posted();
  const fromIndex = futurePosts.findIndex(post => post.id === a);
  const toIndex = futurePosts.findIndex(post => post.id === b);
  if (fromIndex < 0 || toIndex < 0) return;

  // Neighbor ids for the server-authoritative reorder call, computed from
  // the drop target's position with the moved tile conceptually removed
  // first (so it's correct regardless of whether a started before or
  // after b in the list).
  const withoutMoved = futurePosts.filter(post => post.id !== a).map(post => post.id);
  const targetIndex = withoutMoved.indexOf(b);
  const beforeId = targetIndex > 0 ? withoutMoved[targetIndex - 1] : null;
  const afterId = b;

  const [moved] = futurePosts.splice(fromIndex, 1);
  futurePosts.splice(toIndex, 0, { ...moved, updatedBy: currentUser.name, updatedAt: new Date().toISOString() });
  const previousPositions = new Map($$("#grid .tile").map(tile => [tile.dataset.id, tile.getBoundingClientRect()]));
  posts = [...futurePosts, ...donePosts];
  renderAll();
  animateGridReorder(previousPositions);

  const tile = $(`#grid .tile[data-id="${a}"]`);
  tile?.classList.add("reorder-pending");
  tile?.setAttribute("aria-disabled", "true");
  try {
    const result = await api(`/api/assets/${encodeURIComponent(a)}/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ beforeId, afterId, actor: currentUser })
    });
    for (const asset of result.affected || []) posts = replaceAsset(posts, asset);
    renderAll();
  } catch (error) {
    if (error.status === 503) {
      // Row storage isn't enabled in this environment yet — fall back to
      // the legacy whole-document save so reordering keeps working.
      await persistPlanner("reordered the grid");
    } else {
      // Never resend the whole (possibly stale) local planner on a real
      // reorder failure — refresh from the server and let the user retry
      // the drag instead.
      await refreshSharedPlanner();
      notify(error.message || "That reorder didn't save. Refresh and try again.");
    }
  } finally {
    tile?.classList.remove("reorder-pending");
    tile?.removeAttribute("aria-disabled");
  }
}

function animateGridReorder(previousPositions) {
  if (!previousPositions?.size || typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => {
    $$("#grid .tile").forEach(tile => {
      const before = previousPositions.get(tile.dataset.id);
      if (!before) return;
      const after = tile.getBoundingClientRect();
      const x = before.left - after.left;
      const y = before.top - after.top;
      if (Math.abs(x) < 1 && Math.abs(y) < 1) return;
      tile.animate(
        [{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" }],
        { duration: 280, easing: "cubic-bezier(.2,.8,.2,1)" }
      );
    });
  });
}

const FIELD_LABELS = {
  caption: "Caption",
  notes: "Notes",
  workflow: "Workflow",
  assignee: "Assignee",
  priority: "Priority",
  pillar: "Content Pillar",
  type: "Format",
  date: "Schedule Date",
  scheduleState: "Scheduling",
  audio: "Audio Notes",
  hashtags: "Hashtags",
  tagNotes: "Account Tags",
  altText: "Alt Text",
  location: "Location",
  cropZoom: "Crop Zoom",
  status: "Status",
  approval: "Approval"
};

function setEditorFieldValue(host, field, value) {
  const q = selector => host.querySelector(selector);
  if (field === "caption") { const el = q("#eCaption"); if (el) el.value = value || ""; }
  else if (field === "notes") { const el = q("#eNotes"); if (el) el.value = value || ""; }
  else if (field === "workflow") { const el = q("#eWorkflow"); if (el) el.value = value || "idea"; }
  else if (field === "assignee") {
    const el = q("#eAssignee");
    if (el) el.value = value || "";
    const nameEl = q("#assigneePickerName");
    if (nameEl) nameEl.textContent = value || "Unassigned";
    const avEl = q("#assigneePickerButton .person-avatar");
    if (avEl) avEl.textContent = personInitials(value || "Unassigned");
  }
  else if (field === "priority") { const el = q("#ePriority"); if (el) el.value = value || "normal"; }
  else if (field === "pillar") { const el = q("#ePillar"); if (el) el.value = value || ""; }
  else if (field === "type") { const el = q("#eType"); if (el) el.value = value || "IMAGE"; }
  else if (field === "date") { const el = q("#eScheduleDate"); if (el) el.value = value || ""; }
  else if (field === "scheduleState") { const el = q("#eScheduleState"); if (el) el.value = value || "draft"; }
  else if (field === "audio") { const el = q("#eAudio"); if (el) el.value = value || ""; }
  else if (field === "hashtags") { const el = q("#eHashtags"); if (el) el.value = value || ""; }
  else if (field === "tagNotes") { const el = q("#eTagNotes"); if (el) el.value = value || ""; }
  else if (field === "altText") { const el = q("#eAltText"); if (el) el.value = value || ""; }
  else if (field === "location") { const el = q("#eLocation"); if (el) el.value = value || ""; }
  else if (field === "approval") {
    host.querySelectorAll("[data-ap]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.ap === value);
    });
  }
}

function renderConflictPanel(host, conflictState, onResolve) {
  const mount = host.querySelector("#conflictPanelMount");
  if (!mount) return;
  const conflicts = conflictState?.conflicts || {};
  const conflictKeys = Object.keys(conflicts);
  if (!conflictKeys.length) {
    mount.innerHTML = "";
    return;
  }
  mount.innerHTML = `<div class="conflict-panel" id="conflictPanel">
    <div class="conflict-panel-header">
      <b>Same-field changes detected</b>
      <span>A teammate edited this post while you were working. Choose which version to keep for each field below.</span>
    </div>
    <div class="conflict-list">
      ${conflictKeys.map(field => {
        const info = conflicts[field];
        const val = info?.currentValue;
        const displayVal = val == null || val === "" ? "(empty)" : (typeof val === "object" ? JSON.stringify(val) : String(val));
        return `<div class="conflict-item" data-conflict-row="${esc(field)}">
          <div class="conflict-field-info">
            <span class="conflict-field-name">${esc(FIELD_LABELS[field] || field)}</span>
            <span class="conflict-author">${info?.updatedBy ? `Updated by <b>${esc(info.updatedBy)}</b>` : "Updated by teammate"}${info?.updatedAt ? ` on ${new Date(info.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ""}</span>
          </div>
          <div class="conflict-value">
            <small>Current server value:</small>
            <div class="conflict-value-box">${esc(displayVal)}</div>
          </div>
          <div class="conflict-actions">
            <button type="button" class="ghost small" data-conflict-action="keep" data-conflict-field="${esc(field)}">Keep mine</button>
            <button type="button" class="ghost small" data-conflict-action="latest" data-conflict-field="${esc(field)}">Use latest</button>
          </div>
        </div>`;
      }).join("")}
    </div>
  </div>`;

  mount.querySelectorAll("[data-conflict-action]").forEach(btn => {
    btn.onclick = () => {
      const action = btn.dataset.conflictAction;
      const field = btn.dataset.conflictField;
      onResolve(action, field);
    };
  });
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
  const carouselCount = Math.max(carouselImages(post).length, Number(post.canvaPageCount) || 0);
  const isCarousel = post.type === "CAROUSEL" && carouselCount > 1;
  if (isCarousel) carouselSlide = Math.max(0, Math.min(carouselSlide, carouselImages(post).length - 1));
  if (post.status === "posted") {
    host.innerHTML = `<div class="editor"><button class="mobile-editor-close" type="button" aria-label="Close asset editor">×</button>
      <div class="preview-wrap">${assetPreview(post)}</div>
      <div class="posted-lock">This post is live on Instagram and stays locked in the grid.<br><br><b>${post.timestamp ? new Date(post.timestamp).toLocaleDateString() : "Posted"}</b>${post.permalink ? ` · <a href="${esc(post.permalink)}" target="_blank" rel="noopener noreferrer">Open on Instagram</a>` : ""}<br>${esc(formatSchedule(post))}${locationSummary(post)}</div>
      <label class="field">Caption<textarea rows="8" readonly>${esc(post.caption || "")}</textarea></label>
    </div>`;
    q(".mobile-editor-close")?.addEventListener("click", closeGridEditor);
    return;
  }
  const cropLocked = assetKindOf(post) === "video" || post.type === "REEL" || assetSourceOf(post) === "canva";
  const comments = (post.comments || []).map(comment => `<div class="comment"><b>${esc(comment.author)}${comment.role ? ` · ${esc(comment.role)}` : ""}</b>${esc(comment.text)}</div>`).join("");
  const workflowOptions = Object.entries(WORKFLOW_LABELS).map(([key, label]) => `<option value="${key}" ${workflowOf(post) === key ? "selected" : ""}>${label}</option>`).join("");
  const pillarOptions = `<option value="">Choose a pillar</option>` + settings.pillars.map(pillar => `<option ${post.pillar === pillar ? "selected" : ""}>${esc(pillar)}</option>`).join("");
  host.innerHTML = `<div class="editor editable-editor"><button class="mobile-editor-close" type="button" aria-label="Close asset editor">×</button><div class="editor-mobile-heading"><div><span class="eyebrow">EDITING SELECTED POST</span><b>${esc(post.caption || post.notes || assetTypeLabel(post))}</b></div><span>Swipe through fields below</span></div><div class="editor-scroll">
    ${isCarousel ? `<div class="carousel-preview" aria-label="Carousel preview"><img class="carousel-slide" src="${esc(carouselImages(post)[carouselSlide] || post.image)}" alt="Carousel image ${carouselSlide + 1} of ${carouselCount}"><button id="carouselPrev" class="carousel-arrow carousel-prev" type="button" aria-label="Previous carousel image" ${carouselSlide === 0 ? "disabled" : ""}>‹</button><button id="carouselNext" class="carousel-arrow carousel-next" type="button" aria-label="Next carousel image" ${carouselSlide >= carouselCount - 1 ? "disabled" : ""}>›</button><span class="carousel-counter" aria-live="polite">${carouselSlide + 1} / ${carouselCount}</span></div>` : `<div class="preview-wrap${cropLocked ? "" : " crop-preview"}" style="aspect-ratio:${cropFrameRatio(post)}">${assetPreview(post, cropLocked)}${cropLocked ? "" : '<div class="crop-grid" aria-hidden="true"></div><span class="crop-hint">Drag to reposition</span><div class="crop-zoom-overlay"><span>Zoom</span><input id="eCropZoom" type="range" min="1" max="3" step="0.05" value="' + Math.max(1, Math.min(3, Number(post.cropZoom) || 1)) + '" aria-label="Crop zoom"><output id="cropOverlayZoom">100%</output><button id="resetCrop" class="crop-overlay-reset" type="button" aria-label="Reset crop" title="Reset crop">↺</button></div>'}</div>`}
    <div class="asset-meta"><span class="asset-badge">${assetTypeLabel(post)}</span><span class="asset-badge source-${assetSourceOf(post)}">${assetSourceOf(post) === "canva" ? "Canva" : "Uploaded"}</span>${hasReelCover(post) ? '<span class="asset-badge cover-badge">Cover attached</span>' : ""}</div>
    ${post.type === "REEL" || assetKindOf(post) === "video" ? `<div class="cover-card"><div><b>Reel cover photo</b><small>${post.coverImage ? "This image appears on the grid instead of the video frame." : "Add an image to choose the frame shown on the grid."}</small></div>${post.coverImage ? `<img class="cover-thumb" src="${esc(post.coverImage)}" alt="Reel cover photo">` : ""}<div class="handoff-actions"><label class="ghost button-link cover-upload-label">${post.coverImage ? "Replace cover" : "Upload cover photo"}<input id="coverInput" type="file" accept="image/*" hidden></label>${post.coverImage ? '<button id="removeCover" class="ghost" type="button">Remove cover</button>' : ""}</div><small id="coverHelp" class="field-help"></small></div>` : ""}
    <div class="location-card"><div><b>Location tag</b><small>Add the place where this content was created.</small></div><label class="field nested">Location<input id="eLocation" maxlength="120" value="${esc(post.location || post.locationTag?.name || "")}" placeholder="Crystal Bridges, Bentonville"></label><button id="readLocationMetadata" class="ghost" type="button">⌖ Check photo metadata</button><small id="locationHelp" class="field-help">We’ll use the photo’s embedded location when available.</small></div>
    ${post.canvaUrl ? `<div class="canva-source"><b>Canva working draft</b><span>Preview refreshes from Canva when connected.</span><div class="handoff-actions"><a class="ghost button-link" href="${esc(post.canvaUrl)}" target="_blank" rel="noopener noreferrer">Open in Canva</a><button id="refreshCanva" class="ghost">Refresh preview</button></div></div>` : ""}
    <div class="two">
      <label class="field">Workflow<select id="eWorkflow">${workflowOptions}</select></label>
      <label class="field">Assigned to<div class="assignee-picker"><input id="eAssignee" type="hidden" value="${esc(post.assignee || "")}"><button id="assigneePickerButton" class="assignee-picker-button" type="button"><span class="person-avatar">${esc(personInitials(post.assignee || "Unassigned"))}</span><span id="assigneePickerName">${esc(post.assignee || "Unassigned")}</span><span class="assignee-chevron">⌄</span></button><div id="assigneePickerMenu" class="assignee-picker-menu">${assigneePeople(currentUser, team, post.assignee).map(person => `<button type="button" class="assignee-option" data-assignee="${esc(person.name)}"><span class="person-avatar">${esc(personInitials(person.name))}</span><span><b>${esc(person.name)}</b><small>${esc(person.role || "Teammate")}</small></span></button>`).join("")}<button type="button" class="assignee-option" data-assignee=""><span class="person-avatar person-avatar-empty">—</span><span><b>Unassigned</b><small>No owner yet</small></span></button></div></div></label>
    </div>
    <label class="field">Priority<select id="ePriority"><option value="low" ${post.priority === "low" ? "selected" : ""}>Low</option><option value="normal" ${post.priority === "normal" ? "selected" : ""}>Normal</option><option value="high" ${post.priority === "high" ? "selected" : ""}>High</option></select></label>
    <div class="two">
      <label class="field">Content pillar<select id="ePillar">${pillarOptions}</select></label>
      <label class="field">Format<select id="eType">${settings.formats.map(format => `<option ${post.type === format ? "selected" : ""}>${esc(format)}</option>`).join("")}</select></label>
    </div>
    <div class="two">
      <label class="field">Schedule post date<input id="eScheduleDate" type="date" value="${post.date || ""}"></label>
      <label class="field">Scheduling<select id="eScheduleState"><option value="draft" ${post.scheduleState === "draft" ? "selected" : ""}>Not ready</option><option value="ready" ${post.scheduleState === "ready" ? "selected" : ""}>Ready to schedule</option><option value="scheduled" ${post.scheduleState === "scheduled" ? "selected" : ""}>Scheduled</option></select></label>
    </div>
    <label class="field">Caption<textarea id="eCaption" rows="6" placeholder="Write or paste caption…">${esc(post.caption || "")}</textarea></label>
    <label class="field">Notes<textarea id="eNotes" rows="3" placeholder="Audio and manager notes…">${esc(post.notes || "")}</textarea></label>
    ${contentBriefMarkup(post)}
    <div class="field">Approval
      <div class="approval-pills">
        <button data-ap="needs-review" class="${post.approval === "needs-review" ? "active" : ""}">Review</button>
        <button data-ap="feedback" class="${post.approval === "feedback" ? "active" : ""}">Feedback</button>
        <button data-ap="approved" class="${post.approval === "approved" ? "active" : ""}">Approved</button>
      </div>
    </div>
    <div class="field">Comments<div class="comment-list">${comments || `<span style="text-transform:none;font-weight:400">No feedback yet.</span>`}</div>
      <div style="display:flex;gap:6px"><input id="commentText" placeholder="Add feedback as ${esc(currentUser.name)}…" style="flex:1"><button id="addComment" class="ghost">Add</button></div>
    </div>
    <div class="handoff"><b>Meta Business Suite handoff</b><span>Use Meta for final scheduling and publishing.</span><div class="handoff-actions"><button id="copyCaption" class="ghost">Copy caption</button><button id="copyHashtags" class="ghost">Copy hashtags</button><a class="ghost button-link" href="https://business.facebook.com/latest/home" target="_blank" rel="noopener noreferrer">Open Meta</a>${approvedForMeta(post) ? '<button id="downloadApprovedAsset" class="ghost">↓ Download approved media</button><button id="exportMetaData" class="ghost">↓ Export Meta data</button>' : ""}</div><button id="markMeta" class="primary">Mark ready for Meta</button></div>
    <div class="posted-lock">Last updated${post.updatedBy ? ` by <b>${esc(post.updatedBy)}</b>` : ""}${post.updatedAt ? ` on ${new Date(post.updatedAt).toLocaleString()}` : ""}.</div>
    <div id="conflictPanelMount"></div>
    </div>
    <div class="actions"><button id="saveEdit" class="primary">Save</button><button id="deleteEdit" class="danger">Delete</button></div>
  </div>`;
  q(".mobile-editor-close")?.addEventListener("click", closeGridEditor);
  if (hostSelector === "#postEditor") {
    host.querySelectorAll("input, select, textarea").forEach(control => {
      control.addEventListener("input", () => { editorDirty = true; });
      control.addEventListener("change", () => { editorDirty = true; });
    });
  }
  if (!currentEditorBaseline || currentEditorBaseline.id !== post.id) {
    currentEditorBaseline = { id: post.id, ...assetEditorBaseline(post) };
  }
  if (editorConflictState && editorConflictState.asset?.id === post.id) {
    renderConflictPanel(host, editorConflictState, (action, field) => handleConflictResolution(action, field));
  }
  const assigneePicker = q(".assignee-picker");
  if (assigneePicker) {
    const pickerButton = q("#assigneePickerButton");
    const pickerMenu = q("#assigneePickerMenu");
    const positionAssigneeMenu = () => {
      const rect = pickerButton.getBoundingClientRect();
      pickerMenu.style.left = `${rect.left}px`;
      pickerMenu.style.width = `${rect.width}px`;
      pickerMenu.style.top = `${rect.bottom + 6}px`;
      const menuBottom = rect.bottom + 6 + pickerMenu.offsetHeight;
      if (menuBottom > window.innerHeight - 8 && rect.top > pickerMenu.offsetHeight + 14) pickerMenu.style.top = `${rect.top - pickerMenu.offsetHeight - 6}px`;
    };
    pickerButton.onclick = () => {
      assigneePicker.classList.toggle("open");
      if (assigneePicker.classList.contains("open")) requestAnimationFrame(positionAssigneeMenu);
    };
    q(".editor-scroll")?.addEventListener("scroll", () => assigneePicker.classList.remove("open"), { passive: true });
    qq(".assignee-option").forEach(option => option.onclick = () => {
      const value = option.dataset.assignee || "";
      q("#eAssignee").value = value;
      q("#assigneePickerName").textContent = value || "Unassigned";
      q("#assigneePickerButton .person-avatar").textContent = personInitials(value || "Unassigned");
      assigneePicker.classList.remove("open");
      editorDirty = true;
    });
  }
  qq("[data-ap]").forEach(button => {
    button.onclick = async () => {
      const updated = { ...post };
      applyWorkflow(updated, button.dataset.ap);
      const saved = await saveQuickAssetChanges(post, assetEditorChanges(assetEditorBaseline(post), updated), `updated approval for ${post.type.toLowerCase()} content`);
      if (saved) renderAll();
    };
  });
  const cropPreview = q(".crop-preview");
  const cropMedia = q(".crop-media");
  const applyCrop = () => {
    if (!cropPreview || !cropMedia) return;
    cropPreview.style.aspectRatio = cropFrameRatio(post);
    const zoom = cropLocked ? 1 : Math.max(1, Math.min(3, Number(post.cropZoom) || 1));
    const maxX = Math.max(0, cropPreview.getBoundingClientRect().width * (zoom - 1) / 2);
    const maxY = Math.max(0, cropPreview.getBoundingClientRect().height * (zoom - 1) / 2);
    const x = cropLocked ? 50 : cropCoordinate(post.cropX);
    const y = cropLocked ? 50 : cropCoordinate(post.cropY);
    const tx = (x - 50) / 50 * maxX;
    const ty = (y - 50) / 50 * maxY;
    cropMedia.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${zoom})`;
    if (q("#cropOverlayZoom")) q("#cropOverlayZoom").textContent = `${Math.round(zoom * 100)}%`;
    if (q("#eCropZoom")) q("#eCropZoom").value = zoom;
  };
  if (q("#eCropZoom")) {
    q("#eCropZoom").oninput = event => {
      post.cropZoom = Number(event.currentTarget.value);
      applyCrop();
    };
    q("#eCropZoom").onpointerdown = event => event.stopPropagation();
  }
  if (q("#resetCrop")) q("#resetCrop").onclick = () => {
    post.cropZoom = 1;
    post.cropX = 50;
    post.cropY = 50;
    applyCrop();
  };
  if (q("#resetCrop")) q("#resetCrop").onpointerdown = event => event.stopPropagation();
  let dragStart = null;
  if (cropPreview) cropPreview.ondragstart = event => event.preventDefault();
  if (cropPreview) cropPreview.onpointerdown = event => {
    if (cropLocked) return;
    if (!event.isPrimary || event.button !== 0) return;
    if (Number(post.cropZoom || 1) <= 1) return;
    event.preventDefault();
    dragStart = { x: event.clientX, y: event.clientY, cropX: cropCoordinate(post.cropX), cropY: cropCoordinate(post.cropY) };
    cropPreview.classList.add("is-adjusting");
    cropPreview.setPointerCapture(event.pointerId);
  };
  if (cropPreview) cropPreview.onpointermove = event => {
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
    cropPreview.classList.remove("is-adjusting");
    if (event?.pointerId != null && cropPreview.hasPointerCapture(event.pointerId)) cropPreview.releasePointerCapture(event.pointerId);
  };
  if (cropPreview) cropPreview.onpointerup = stopPan;
  if (cropPreview) cropPreview.onpointercancel = stopPan;
  if (cropPreview) cropPreview.onlostpointercapture = () => { dragStart = null; cropPreview.classList.remove("is-adjusting"); };
  applyCrop();

  const handleConflictResolution = async (action, field) => {
    if (!editorConflictState) return;
    if (action === "latest") {
      const val = editorConflictState.conflicts[field]?.currentValue;
      setEditorFieldValue(host, field, val);
      editorConflictState.changes = removeConflictField(editorConflictState.changes, field);
      delete editorConflictState.conflicts[field];
      if (!Object.keys(editorConflictState.conflicts).length) {
        if (!Object.keys(editorConflictState.changes).length) {
          posts = replaceAsset(posts, editorConflictState.asset);
          currentEditorBaseline = { id: editorConflictState.asset.id, ...assetEditorBaseline(editorConflictState.asset) };
          editorConflictState = null;
          renderConflictPanel(host, null, handleConflictResolution);
          editorDirty = false;
          renderAll();
          switchView(editorDestinationAfterSave(currentView, editorReturnView));
          notify("Post updated");
          return;
        }
        renderConflictPanel(host, null, handleConflictResolution);
        await submitAssetPatch();
      } else {
        renderConflictPanel(host, editorConflictState, handleConflictResolution);
      }
    } else if (action === "keep") {
      editorConflictState.forceFields = forceConflictField(editorConflictState.forceFields, field);
      delete editorConflictState.conflicts[field];
      if (!Object.keys(editorConflictState.conflicts).length) {
        renderConflictPanel(host, null, handleConflictResolution);
        await submitAssetPatch();
      } else {
        renderConflictPanel(host, editorConflictState, handleConflictResolution);
      }
    }
  };

  const submitAssetPatch = async () => {
    const saveButton = q("#saveEdit");
    editorSaveInProgress = true;
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.textContent = "Saving…";
    }

    const baseline = currentEditorBaseline || assetEditorBaseline(post);
    post.type = q("#eType").value;
    applyWorkflow(post, q("#eWorkflow").value);
    post.assignee = q("#eAssignee").value.trim();
    post.priority = q("#ePriority").value;
    post.pillar = q("#ePillar").value;
    post.date = q("#eScheduleDate").value;
    post.scheduleState = q("#eScheduleState").value;
    post.caption = q("#eCaption").value;
    post.notes = q("#eNotes").value;
    post.audio = q("#eAudio") ? q("#eAudio").value.trim() : post.audio;
    post.hashtags = q("#eHashtags") ? q("#eHashtags").value.trim() : post.hashtags;
    post.tagNotes = q("#eTagNotes") ? q("#eTagNotes").value.trim() : post.tagNotes;
    post.altText = q("#eAltText") ? q("#eAltText").value.trim() : post.altText;
    post.location = q("#eLocation") ? q("#eLocation").value.trim() : post.location;
    post.locationTag = post.location ? { ...(post.locationTag || {}), name: post.location, source: post.locationTag?.source || "manual" } : null;

    const baseChanges = editorConflictState?.changes ? editorConflictState.changes : assetEditorChanges(baseline, post);
    const forceFields = editorConflictState?.forceFields || [];
    const revision = editorConflictState?.asset?.revision || baseline.revision;

    if (!Object.keys(baseChanges).length && !forceFields.length) {
      editorDirty = false;
      editorConflictState = null;
      renderAll();
      switchView(editorDestinationAfterSave(currentView, editorReturnView));
      notify("Post updated");
      editorSaveInProgress = false;
      if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = "Save";
      }
      return;
    }

    try {
      const res = await api(`/api/assets/${post.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision,
          changes: baseChanges,
          forceFields,
          actor: currentUser
        })
      });
      posts = replaceAsset(posts, res.asset);
      selected = res.asset.id;
      currentEditorBaseline = { id: res.asset.id, ...assetEditorBaseline(res.asset) };
      editorConflictState = null;
      editorDirty = false;
      renderAll();
      switchView(editorDestinationAfterSave(currentView, editorReturnView));
      notify(res.merged ? "Saved alongside a teammate’s changes" : "Post updated");
    } catch (error) {
      if (error.status === 409 && error.conflicts) {
        editorConflictState = {
          asset: error.asset,
          conflicts: error.conflicts,
          changes: baseChanges,
          forceFields: []
        };
        renderConflictPanel(host, editorConflictState, handleConflictResolution);
        notify(error.message || "This asset changed while you were editing it.");
      } else if (error.status === 404) {
        posts = posts.filter(item => item.id !== post.id);
        selected = null;
        editorConflictState = null;
        editorDirty = false;
        renderAll();
        switchView(editorDestinationAfterSave(currentView, editorReturnView));
        notify("This asset was removed by a teammate.");
      } else {
        notify(error.message || "The post could not be saved");
      }
    } finally {
      editorSaveInProgress = false;
      if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = "Save";
      }
    }
  };

  q("#saveEdit").onclick = submitAssetPatch;
  q("#deleteEdit").onclick = async () => {
    if (post.metaId) return notify("Instagram posts stay in the grid");
    const previousPosts = posts;
    const deleteButton = q("#deleteEdit");
    deleteButton.disabled = true;
    deleteButton.textContent = "Deleting…";
    posts = posts.filter(item => item.id !== post.id);
    selected = null;
    try {
      const result = await narrowOrFallback(() => api(`/api/assets/${encodeURIComponent(post.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: currentUser, reason: "removed a post" })
      }));
      if (result.fallback) await persistPlanner("removed a post");
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
  if (q("#downloadApprovedAsset")) q("#downloadApprovedAsset").onclick = () => downloadAsset(post);
  if (q("#exportMetaData")) q("#exportMetaData").onclick = () => exportMetaData(post);
  if (q("#refreshCanva")) q("#refreshCanva").onclick = () => refreshCanvaPreview(post, q("#refreshCanva"));
  if (q("#carouselPrev")) q("#carouselPrev").onclick = () => { carouselSlide = Math.max(0, carouselSlide - 1); renderInspector(hostSelector); };
  if (q("#carouselNext")) q("#carouselNext").onclick = async () => {
    if (carouselImages(post).length < carouselCount) {
      await refreshCanvaPreview(post, q("#refreshCanva"));
    }
    if (carouselImages(post).length < 2) {
      notify("Canva has not returned the carousel pages yet. Try Refresh preview again.");
      return;
    }
    carouselSlide = Math.min(carouselImages(post).length - 1, carouselSlide + 1);
    renderInspector(hostSelector);
  };
  if (q("#coverInput")) q("#coverInput").onchange = async event => {
    const [file] = event.target.files;
    if (!file) return;
    if (!file.type.startsWith("image/")) return notify("Choose an image for the reel cover");
    if (file.size > 30 * 1024 * 1024) return notify("Cover photos must be 30 MB or smaller");
    const help = q("#coverHelp");
    if (help) help.textContent = "Uploading cover photo…";
    try {
      const uploadFile = await prepareUploadFile(file);
      if (uploadFile.size > 3 * 1024 * 1024) throw new Error("This asset is too large for the hosted upload connection. Photos are compressed automatically; videos must be under 3 MB.");
      const uploaded = await api("/api/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: uploadFile.name, data: await readFile(uploadFile) }) });
      const saved = await saveQuickAssetChanges(post, { coverImage: uploaded.url }, "added a reel cover photo");
      if (saved) { renderAll(); notify("Reel cover photo attached"); }
    } catch (error) { if (help) help.textContent = "Cover upload failed"; notify(error.message || "Cover photo upload failed"); }
    finally { event.target.value = ""; }
  };
  if (q("#removeCover")) q("#removeCover").onclick = async () => {
    const saved = await saveQuickAssetChanges(post, { coverImage: "" }, "removed a reel cover photo");
    if (saved) { renderAll(); notify("Reel cover removed"); }
  };
  q("#markMeta").onclick = async () => {
    const updated = { ...post };
    applyWorkflow(updated, "ready-meta");
    const saved = await saveQuickAssetChanges(post, assetEditorChanges(assetEditorBaseline(post), updated), "marked content ready for Meta Business Suite");
    if (saved) { renderAll(); notify("Ready for Meta Business Suite"); }
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
    const comment = { author: currentUser.name, role: currentUser.role, text: value, at: new Date().toISOString() };
    const saved = await saveQuickAssetChanges(post, { comments: [...(post.comments || []), comment] }, "left feedback on a post");
    if (saved) renderAll();
  };
}
async function refreshCanvaPreview(post, button = $("#refreshCanva")) {
  if (button) { button.disabled = true; button.textContent = "Refreshing…"; }
  try {
    const data = await api("/api/canva/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ canvaUrl: post.canvaUrl, designId: post.canvaDesignId || undefined, pageCount: post.canvaPageCount || 0, designTypes: post.canvaDesignTypes || [], doctypeName: post.canvaDoctypeName || "" }) });
    const updated = { ...post, image: data.previewUrl };
    if (Array.isArray(data.images) && data.images.length) updated.images = data.images;
    if (data.mediaType === "video") {
      updated.assetKind = "video";
      updated.type = "REEL";
      updated.canvaAssetType = "video";
    } else if (data.contentType === "carousel") {
      updated.assetKind = "image";
      updated.type = "CAROUSEL";
      updated.canvaAssetType = "image";
    }
    updated.canvaPreviewUpdatedAt = new Date().toISOString();
    const saved = await saveQuickAssetChanges(post, assetEditorChanges(assetEditorBaseline(post), updated), "refreshed a Canva preview");
    if (saved) { renderAll(); notify("Canva preview refreshed"); }
  } catch (error) { notify(error.message || "Canva preview could not be refreshed"); }
  finally {
    if (button) { button.disabled = false; button.textContent = "Refresh preview"; }
  }
  return posts.find(item => item.id === post.id) || post;
}
function renderCalendarYear(year) {
  const months = Array.from({ length: 12 }, (_, index) => {
    const key = year + "-" + String(index + 1).padStart(2, "0");
    const items = calendarPosts().filter(post => post.date?.slice(0, 7) === key);
    const dots = new Set(items.map(post => post.date));
    return '<button class="year-month" type="button" data-year-month="' + key + '"><strong>' + new Date(year, index, 1).toLocaleDateString(undefined, { month: "long" }) + '</strong><span>' + items.length + ' ' + (items.length === 1 ? "post" : "posts") + '</span><div class="year-dots">' + (Array.from(dots).slice(0, 12).map(() => "<i></i>").join("") || "<em>No posts</em>") + "</div></button>";
  }).join("");
  $("#calendar").innerHTML = '<div class="calendar-year">' + months + "</div>";
  $("#calendarAgenda").innerHTML = "";
  $$("#calendar [data-year-month]").forEach(button => button.onclick = () => {
    calendarView = "month";
    calCursor = new Date(button.dataset.yearMonth + "-01T12:00:00");
    renderCalendar();
  });
}
function renderCalendar() {
  const year = calCursor.getFullYear(), month = calCursor.getMonth();
  const begin = calendarView === "week" ? new Date(calCursor.getFullYear(), calCursor.getMonth(), calCursor.getDate() - calCursor.getDay()) : new Date(year, month, 1 - new Date(year, month, 1).getDay());
  const weekEnd = new Date(begin); weekEnd.setDate(begin.getDate() + 6);
  $("#monthLabel").textContent = calendarView === "year" ? String(year) : calendarView === "week" ? begin.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " – " + weekEnd.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : calCursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  $$("#calendarViewSwitcher [data-calendar-view]").forEach(button => button.classList.toggle("active", button.dataset.calendarView === calendarView));
  if (calendarView === "year") return renderCalendarYear(year);
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const calendarPostMarkup = (post, extraClass = "") => `<div class="cal-post ${extraClass}" data-workflow="${workflowOf(post)}" draggable="true" data-open="${post.id}" data-drag-post="${post.id}" role="button" tabindex="0" aria-label="Edit ${esc(post.notes || post.caption || post.type || "post")}"><img src="${esc(gridImageOf(post))}" alt=""><span>${esc((post.caption || post.notes || post.type || "Post").slice(0, 28))}<small>${esc(post.time || scheduleLabel(post))}</small></span></div>`;
  let html = names.map(name => `<div class="cal-head">${name}</div>`).join("");
  for (let i = 0; i < (calendarView === "week" ? 7 : 42); i++) {
    const day = new Date(begin);
    day.setDate(begin.getDate() + i);
    const iso = day.toISOString().slice(0, 10);
    const items = calendarPosts().filter(post => post.date === iso).sort((a, b) => (a.time || "23:59").localeCompare(b.time || "23:59"));
    html += `<div class="day ${day.getMonth() !== month ? "muted" : ""}" data-day="${iso}"><div class="day-num">${day.getDate()}</div>${items.slice(0, 3).map(post => calendarPostMarkup(post)).join("")}${items.length > 3 ? `${items.slice(3).map(post => calendarPostMarkup(post, "is-overflow")).join("")}<button class="calendar-more" type="button" data-calendar-more="${iso}">+${items.length - 3} more</button>` : ""}</div>`;
  }
  $("#calendar").innerHTML = html;
  $$("#calendar .cal-post, #calendarAgenda .cal-post").forEach(node => {
    const post = posts.find(item => item.id === node.dataset.open);
    if (post?.status === "posted") {
      node.classList.add("instagram-post", "instagram-badge");
      node.dataset.instagram = "true";
      node.draggable = false;
      node.setAttribute("aria-label", `Open ${esc(post.caption || "Instagram post")} on Instagram`);
    }
  });
  const today = new Date();
  const todayIso = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
  $$("#calendar .day[data-day]").forEach(day => day.classList.toggle("is-today", day.dataset.day === todayIso));
  const monthPosts = calendarPosts().filter(post => post.date && post.date.slice(0, 7) === `${year}-${String(month + 1).padStart(2, "0")}`).sort((a, b) => `${a.date} ${a.time || "23:59"}`.localeCompare(`${b.date} ${b.time || "23:59"}`));
  const agendaPosts = calendarView === "week" ? calendarPosts().filter(post => post.date >= begin.toISOString().slice(0, 10) && post.date <= new Date(begin.getTime() + 6 * 86400000).toISOString().slice(0, 10)) : monthPosts;
  const grouped = agendaPosts.reduce((groups, post) => { (groups[post.date] ||= []).push(post); return groups; }, {});
  $("#calendarAgenda").innerHTML = Object.entries(grouped).map(([date, items]) => `<section class="agenda-day"><div class="agenda-date"><strong>${new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" })}</strong><span>${new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span><small>${items.length} ${items.length === 1 ? "post" : "posts"}</small></div><div class="agenda-posts">${items.map(post => calendarPostMarkup(post)).join("")}</div></section>`).join("") || `<div class="empty">No planned posts this month.</div>`;
  $$("#calendarAgenda .cal-post").forEach(node => {
    const post = posts.find(item => item.id === node.dataset.open);
    if (post?.status === "posted") {
      node.classList.add("instagram-post", "instagram-badge");
      node.dataset.instagram = "true";
      node.draggable = false;
      node.setAttribute("aria-label", `Open ${esc(post.caption || "Instagram post")} on Instagram`);
    }
  });
  const handleCalendarPostClick = id => {
    const post = posts.find(item => item.id === id);
    if (post?.status === "posted") {
      window.open(post.permalink || "https://www.instagram.com/", "_blank", "noopener,noreferrer");
      return;
    }
    openPost(id, true);
  };
  $("#calendar").querySelectorAll("[data-open]").forEach(node => {
    node.onclick = () => {
      if (Date.now() < suppressCalendarClickUntil) return;
      handleCalendarPostClick(node.dataset.open);
    };
    node.onkeydown = event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleCalendarPostClick(node.dataset.open);
      }
    };
  });
  $("#calendarAgenda").querySelectorAll("[data-open]").forEach(node => {
    node.onclick = () => handleCalendarPostClick(node.dataset.open);
    node.onkeydown = event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleCalendarPostClick(node.dataset.open);
      }
    };
  });
  $$('[data-calendar-more]').forEach(button => button.onclick = event => {
    event.stopPropagation();
    const day = button.closest('.day');
    const expanded = day.classList.toggle('is-expanded');
    button.textContent = expanded ? 'Show less' : `+${day.querySelectorAll('.cal-post.is-overflow').length} more`;
  });
  $$("[data-drag-post]").forEach(node => node.ondragstart = event => { if (node.dataset.instagram === "true") return event.preventDefault(); dragId = node.dataset.dragPost; event.stopPropagation(); });
  $$("[data-drag-post]").forEach(node => {
    node.addEventListener("selectstart", event => event.preventDefault());
    node.addEventListener("pointerdown", event => {
      if (!event.isPrimary || event.pointerType === "mouse" || event.button !== 0 || node.dataset.instagram === "true") return;
      calendarTouch = { id: node.dataset.dragPost, node, x: event.clientX, y: event.clientY, timer: setTimeout(() => {
        if (!calendarTouch || calendarTouch.node !== node) return;
        calendarTouch.active = true;
        node.classList.add("dragging");
        node.setPointerCapture(event.pointerId);
      }, 220) };
    });
    node.addEventListener("pointermove", event => {
      if (!calendarTouch || calendarTouch.node !== node) return;
      if (!calendarTouch.active) {
        const distance = Math.hypot(event.clientX - calendarTouch.x, event.clientY - calendarTouch.y);
        if (distance > 10) clearTimeout(calendarTouch.timer);
        return;
      }
      event.preventDefault();
      $$(".day").forEach(day => day.classList.remove("target"));
      document.elementFromPoint(event.clientX, event.clientY)?.closest(".day")?.classList.add("target");
    });
    const finishCalendarTouch = async event => {
      if (!calendarTouch || calendarTouch.node !== node) return;
      clearTimeout(calendarTouch.timer);
      const state = calendarTouch;
      calendarTouch = null;
      node.classList.remove("dragging");
      $$(".day").forEach(day => day.classList.remove("target"));
      if (!state.active) return;
      suppressCalendarClickUntil = Date.now() + 450;
      event.preventDefault();
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".day");
      const post = posts.find(item => item.id === state.id);
      if (!post || !target) return;
      const saved = await saveQuickAssetChanges(post, { date: target.dataset.day }, "moved content on the calendar");
      if (saved) { renderAll(); notify("Publish date updated"); }
    };
    node.addEventListener("pointerup", finishCalendarTouch);
    node.addEventListener("pointercancel", finishCalendarTouch);
  });
  $$(".day[data-day]").forEach(node => {
    node.ondragover = event => { if (dragId) event.preventDefault(); };
    node.ondrop = async event => { event.preventDefault(); const post = posts.find(item => item.id === dragId); if (!post) return; dragId = null; const saved = await saveQuickAssetChanges(post, { date: node.dataset.day }, "moved content on the calendar"); if (saved) { renderAll(); notify("Publish date updated"); } };
  });
}
function renderLibrary() {
  const query = librarySearch.toLowerCase();
  const items = future().filter(post => {
    const matchesFilter = libraryFilter === "all" || post.status === libraryFilter || post.approval === libraryFilter || workflowOf(post) === libraryFilter;
    const searchable = [post.caption, post.notes, post.pillar, post.client, post.assignee, post.location].join(" ").toLowerCase();
    return matchesFilter && (!query || searchable.includes(query));
  });
  $("#library").innerHTML = items.length
    ? items.map(post => `<article class="library-card" data-open-editor="${post.id}"><div class="library-media">${assetMediaMarkup(post)}<div class="library-badges">${workflowPill(workflowOf(post))}</div><div class="library-asset-badges">${libraryAssetBadges(post)}</div></div><div class="library-info"><b>${esc(post.notes || post.caption || "Untitled content")}</b><span>${esc(`${post.type} · ${formatSchedule(post)} · ${WORKFLOW_LABELS[workflowOf(post)]}${post.pillar ? ` · ${post.pillar}` : ""}`)}</span>${post.location ? `<small class="library-location">⌖ ${esc(post.location)}</small>` : ""}</div></article>`).join("")
    : `<div class="empty">No content in this view yet.</div>`;
  $$("[data-open-editor]").forEach(node => node.onclick = () => openPost(node.dataset.openEditor, true));
}
function renderScratch() {
  const host = $("#scratchList");
  if (!host) return;
  populateScratchSelects();
  const entries = scratch.filter(entry => entry.status !== "archived");
  host.innerHTML = entries.length ? entries.map(entry => {
    const images = Array.isArray(entry.images) && entry.images.length ? entry.images : (entry.image ? [entry.image] : []);
    const comments = Array.isArray(entry.comments) ? entry.comments : [];
    const timeDisplay = formatIdeaTimestamp(entry.createdAt);
    const updatedDisplay = (entry.updatedAt && entry.updatedAt !== entry.createdAt) ? ` · Updated ${formatIdeaTimestamp(entry.updatedAt)}` : "";

    return `<article class="scratch-card" data-scratch-id="${esc(entry.id)}">
      <div class="scratch-card-head">
        <div>
          <div class="scratch-card-meta">
            <span class="eyebrow">${esc(entry.createdBy || "Team")}</span>
            ${entry.format ? `<span class="scratch-badge scratch-badge-format">${esc(entry.format)}</span>` : ""}
            ${entry.pillar ? `<span class="scratch-badge scratch-badge-pillar">${esc(entry.pillar)}</span>` : ""}
            <time class="scratch-time">${esc(timeDisplay)}${esc(updatedDisplay)}</time>
          </div>
          <h4>${esc(entry.title || "Untitled idea")}</h4>
        </div>
        <button class="ghost scratch-archive" type="button">Archive</button>
      </div>
      ${images.length > 1 ? `
        <div class="scratch-gallery">
          ${images.map(img => `<img src="${esc(img)}" alt="Idea photo" class="scratch-gallery-img">`).join("")}
        </div>
      ` : (images.length === 1 ? `<img src="${esc(images[0])}" alt="Idea photo" class="scratch-card-img">` : "")}
      ${entry.body ? `<p>${esc(entry.body)}</p>` : ""}
      ${entry.goal || entry.hook || entry.cta ? `<div class="scratch-brief">
        ${entry.goal ? `<span><b>Goal</b>${esc(entry.goal)}</span>` : ""}
        ${entry.hook ? `<span><b>Hook</b>${esc(entry.hook)}</span>` : ""}
        ${entry.cta ? `<span><b>CTA</b>${esc(entry.cta)}</span>` : ""}
      </div>` : ""}
      ${(entry.tags && entry.tags.length) ? `<div class="scratch-tags">${entry.tags.map(tag => `<span>#${esc(tag)}</span>`).join("")}</div>` : ""}
      
      <div class="scratch-comments-section">
        <div class="scratch-comments-head">
          <b>Feedback & Notes ${comments.length ? `(${comments.length})` : ""}</b>
        </div>
        <div class="comment-list scratch-comment-list">
          ${comments.map(c => `
            <div class="comment scratch-comment" data-comment-id="${esc(c.id || '')}">
              <div class="scratch-comment-head">
                <b>${esc(c.author || 'Team')}${c.role ? ` · <span class="comment-role">${esc(c.role)}</span>` : ''}</b>
                <time class="comment-time">${esc(formatIdeaTimestamp(c.at))}</time>
                <button class="ghost comment-delete-btn" type="button" data-idea-id="${esc(entry.id)}" data-comment-id="${esc(c.id || '')}" title="Delete comment">×</button>
              </div>
              <div class="comment-text">${esc(c.text || '')}</div>
            </div>
          `).join("") || '<span class="scratch-no-comments">No feedback yet. Add thoughts below to collaborate.</span>'}
        </div>
        <form class="scratch-comment-form" data-idea-id="${esc(entry.id)}">
          <input class="scratch-comment-input" placeholder="Add feedback as ${esc(currentUser.name)}…" maxlength="1000" required>
          <button class="ghost" type="submit">Post</button>
        </form>
      </div>

      <div class="scratch-card-actions">
        <button class="ghost scratch-edit" type="button">Edit</button>
        <button class="danger scratch-delete" type="button">Delete</button>
      </div>
    </article>`;
  }).join("") : `<div class="empty">No ideas saved yet. Capture the next idea before it gets away.</div>`;

  $$(".scratch-archive").forEach(button => button.onclick = async event => {
    const entry = scratch.find(item => item.id === event.currentTarget.closest("[data-scratch-id]").dataset.scratchId);
    if (!entry) return;
    entry.status = "archived";
    entry.updatedBy = currentUser.name;
    entry.updatedAt = new Date().toISOString();
    renderScratch();
    await saveIdea(entry, { status: "archived" }, "archived an idea");
  });

  $$(".scratch-delete").forEach(button => button.onclick = async event => {
    const id = event.currentTarget.closest("[data-scratch-id]").dataset.scratchId;
    scratch = scratch.filter(entry => entry.id !== id);
    renderScratch();
    await deleteIdeaNarrow(id, "deleted an idea");
  });

  $$(".scratch-comment-form").forEach(form => {
    form.onsubmit = async event => {
      event.preventDefault();
      const ideaId = form.dataset.ideaId;
      const entry = scratch.find(item => item.id === ideaId);
      if (!entry) return;
      const input = form.querySelector(".scratch-comment-input");
      const text = input.value.trim();
      if (!text) return;
      entry.comments = Array.isArray(entry.comments) ? entry.comments : [];
      entry.comments.push({
        id: crypto.randomUUID(),
        author: currentUser.name,
        role: currentUser.role,
        text,
        at: new Date().toISOString()
      });
      entry.updatedBy = currentUser.name;
      entry.updatedAt = new Date().toISOString();
      renderScratch();
      await saveIdea(entry, { comments: entry.comments }, "commented on an idea");
      notify("Feedback posted");
    };
  });

  $$(".comment-delete-btn").forEach(btn => {
    btn.onclick = async () => {
      const ideaId = btn.dataset.ideaId;
      const commentId = btn.dataset.commentId;
      const entry = scratch.find(item => item.id === ideaId);
      if (!entry || !Array.isArray(entry.comments)) return;
      entry.comments = entry.comments.filter(c => c.id !== commentId);
      entry.updatedBy = currentUser.name;
      entry.updatedAt = new Date().toISOString();
      renderScratch();
      await saveIdea(entry, { comments: entry.comments }, "removed a comment from an idea");
      notify("Comment removed");
    };
  });

  $$(".scratch-edit").forEach(button => button.onclick = () => {
    const card = button.closest("[data-scratch-id]"), entry = scratch.find(item => item.id === card.dataset.scratchId);
    if (!entry) return;
    populateScratchSelects();
    scratchAttachedImages = Array.isArray(entry.images) && entry.images.length ? [...entry.images] : (entry.image ? [entry.image] : []);
    renderScratchPhotosTray();
    $("#scratchTitle").value = entry.title || "";
    $("#scratchFormat").value = entry.format || "";
    $("#scratchPillar").value = entry.pillar || "";
    $("#scratchBody").value = entry.body || "";
    $("#scratchGoal").value = entry.goal || "";
    $("#scratchHook").value = entry.hook || "";
    $("#scratchCta").value = entry.cta || "";
    $("#scratchImage").value = "";
    $("#scratchTags").value = (entry.tags || []).join(", ");
    $("#scratchForm").dataset.editing = entry.id;
    $("#scratchForm button[type=submit]").textContent = "Update idea";
    const cancelBtn = $("#scratchCancelEdit");
    if (cancelBtn) cancelBtn.classList.remove("hidden");
    setLibrarySection("ideas");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}
function setLibrarySection(section) {
  librarySection = section === "ideas" ? "ideas" : "assets";
  $("#assetLibraryPanel").classList.toggle("hidden", librarySection !== "assets");
  $("#ideasPanel").classList.toggle("hidden", librarySection !== "ideas");
  $("#assetLibraryTab").classList.toggle("active", librarySection === "assets");
  $("#ideasTab").classList.toggle("active", librarySection === "ideas");
  $("#assetLibraryTab").setAttribute("aria-selected", String(librarySection === "assets"));
  $("#ideasTab").setAttribute("aria-selected", String(librarySection === "ideas"));
  if (librarySection === "ideas") renderScratch();
}
function renderApprovals() {
  const host = $("#approvalPanel");
  if (!host) return;
  const sections = approvalSections(future());
  if (approvalDetail) {
    const section = sections.find(item => item.key === approvalDetail);
    if (!section) { approvalDetail = null; return renderApprovals(); }
    host.innerHTML = `<div class="approval-detail-head"><div><p class="eyebrow">APPROVAL QUEUE</p><h3>${esc(section.label)}</h3><p>Review every item in this section.</p></div><button id="backToApprovals" class="ghost" type="button">← All approvals</button></div><div class="approval-detail-list">${section.posts.map(post => `<button class="approval-card" data-open="${post.id}" type="button"><img src="${esc(post.image)}" alt=""><span>${workflowPill(section.key)}<b>${esc(post.notes || post.caption || post.type)}</b><small>${esc(formatSchedule(post))}</small></span></button>`).join("") || `<div class="empty">Nothing here.</div>`}</div>`;
    $("#backToApprovals").onclick = () => { approvalDetail = null; renderTasks(); };
    $$("#approvalPanel [data-open]").forEach(node => node.onclick = () => openPost(node.dataset.open, true));
    return;
  }
  host.innerHTML = `<div class="approval-intro"><div><p class="eyebrow">REVIEW QUEUE</p><h3>Approvals</h3><p>Keep every stage of review visible without stacking the queue.</p></div></div><div class="approval-board">${sections.map(section => {
    const post = section.posts[0];
    return `<section class="approval-col" data-workflow="${section.key}"><h4>${esc(section.label)}</h4>${post ? `<button class="approval-summary" data-approval-section="${section.key}" type="button"><img src="${esc(post.image)}" alt=""><span>${workflowPill(section.key)}<b>${esc(post.notes || post.caption || post.type)}</b><small>${esc(formatSchedule(post))}</small></span>${section.remaining ? `<strong class="approval-more">+${section.remaining}</strong>` : ""}</button>` : `<div class="empty">Nothing here.</div>`}</section>`;
  }).join("")}</div>`;
  $$("#approvalPanel [data-approval-section]").forEach(node => node.onclick = () => {
    const section = sections.find(item => item.key === node.dataset.approvalSection);
    if (section.count > 1) { approvalDetail = section.key; renderApprovals(); }
    else if (section.posts[0]) openPost(section.posts[0].id, true);
  });
}
function openPost(id, openEditor = false) {
  selected = id;
  const post = posts.find(item => item.id === id);
  if (post) {
    currentEditorBaseline = { id: post.id, ...assetEditorBaseline(post) };
    editorConflictState = null;
  }
  if (openEditor) {
    editorDirty = false;
    editorReturnView = currentView;
    switchView("editor");
  } else {
    switchView("grid");
    renderGrid();
    renderInspector();
    if (window.matchMedia("(max-width: 700px)").matches) setGridEditorOpen(true);
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function switchView(name) {
  currentView = name;
  syncTopActions(name);
  $$(".view").forEach(view => view.classList.add("hidden"));
  $(`#view-${name}`)?.classList.remove("hidden");
  $$(".nav").forEach(nav => nav.classList.toggle("active", nav.dataset.view === name));
  $("#pageTitle").textContent = { grid: "Grid Planner", calendar: "Calendar", library: "Library", tasks: "Tasks", approvals: "Approvals", activity: "Team Activity", editor: "Edit post", settings: "Settings" }[name] || "Planner";
  if (name !== "grid" && $("#inspector")) $("#inspector").innerHTML = "";
  if (name !== "editor" && $("#postEditor")) $("#postEditor").innerHTML = "";
  if (!isPlannerLoaded) {
    if (name === "tasks") { renderTasksSkeleton(); renderActivitySkeleton(); }
    if (name === "grid") renderGridSkeleton();
    if (name === "calendar") renderCalendarSkeleton();
    if (name === "library") renderLibrarySkeleton();
    if (name === "settings") renderSettingsSkeleton();
    if (name === "editor") renderEditorSkeleton();
    closeMobileMenu();
    return;
  }
  if (name === "settings") renderPlannerSettings();
  if (name === "activity") renderActivity();
  if (name === "tasks") { renderTasks(); renderActivity(); }
  if (name === "library") { setLibrarySection(librarySection); renderLibrary(); }
  if (name === "grid") renderInspector();
  if (name === "editor") renderInspector("#postEditor");
  closeMobileMenu();
}
function closeMobileMenu() {
  document.body.classList.remove("mobile-menu-open");
  const button = $("#mobileMenuBtn");
  const backdrop = $("#mobileMenuBackdrop");
  button?.setAttribute("aria-expanded", "false");
  button?.setAttribute("aria-label", "Open navigation menu");
  backdrop?.classList.add("hidden");
  backdrop?.setAttribute("aria-hidden", "true");
}
function toggleMobileMenu() {
  const open = !document.body.classList.contains("mobile-menu-open");
  document.body.classList.toggle("mobile-menu-open", open);
  const button = $("#mobileMenuBtn");
  const backdrop = $("#mobileMenuBackdrop");
  button?.setAttribute("aria-expanded", String(open));
  button?.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
  backdrop?.classList.toggle("hidden", !open);
  backdrop?.setAttribute("aria-hidden", String(!open));
}
async function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function prepareUploadFile(file) {
  // Vercel Functions accept only a 4.5 MB request body. Because the upload is
  // sent as base64 JSON, keep browser-compressed photos below 3 MB so normal
  // camera images do not hit that platform limit.
  if (!file.type.startsWith("image/") || file.size <= 3 * 1024 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, Math.sqrt((3 * 1024 * 1024) / file.size));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.84));
    if (blob && blob.size < file.size) return new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" });
  } catch {}
  return file;
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
  let usedRowStorageFallback = false;
  try {
    for (const [index, file] of validFiles.entries()) {
      uploadStatus.textContent = "Uploading " + (index + 1) + " of " + validFiles.length + "…";
      const photoGps = file.type.startsWith("image/") ? await readExifGps(file) : null;
      const uploadFile = await prepareUploadFile(file);
      if (uploadFile.size > 3 * 1024 * 1024) throw new Error("This asset is too large for the hosted upload connection. Photos are compressed automatically; videos must be under 3 MB.");
      const uploaded = await api("/api/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: uploadFile.name, data: await readFile(uploadFile) }) });
      const id = crypto.randomUUID();
      firstId ||= id;
      const uploadedPost = {
        id,
        image: uploaded.url,
        assetKind: uploaded.kind,
        assetSource: "uploaded",
        cropRatio: uploaded.kind === "video" ? "9:16" : "4:5",
        status: "draft",
        approval: "feedback",
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
      // Create the planner row right after this upload's Blob step succeeds,
      // independent of the other files in this batch. Falls back to a
      // legacy whole-document save (below, once) only if row storage isn't
      // enabled — the flag doesn't change mid-batch, so this only ever
      // triggers once, on the first file.
      const created = await narrowOrFallback(() => api("/api/planner/assets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset: uploadedPost, actor: currentUser, reason: "uploaded new content" })
      }));
      if (created.fallback) usedRowStorageFallback = true;
      else posts = replaceAsset(posts, created.data.asset);
    }
    selected = firstId;
    renderAll();
    if (usedRowStorageFallback) {
      try {
        await persistPlanner("uploaded new content");
      } catch (error) {
        if (error.status !== 409 || !error.planner) throw error;
        const uploadedIds = new Set(uploadedPosts.map(post => post.id));
        setPlanner(error.planner);
        posts = [...uploadedPosts, ...posts.filter(post => !uploadedIds.has(post.id))];
        await persistPlanner("uploaded new content after a shared planner refresh");
      }
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
  host.innerHTML = '<div class="empty"><span class="loading-spinner-inline" style="margin-right:8px" aria-hidden="true"></span>Loading Canva designs…</div>';
  try {
    const data = await api(`/api/canva/designs${query ? `?query=${encodeURIComponent(query)}` : ""}`);
    host.innerHTML = data.designs?.length ? data.designs.map(design => `<button class="canva-design" data-canva-id="${esc(design.id)}"><img src="${esc(design.thumbnail)}" alt=""><span><b>${esc(design.title)}</b><small>${esc(design.doctypeName || (design.designTypes || []).map(type => type.replaceAll("_", " ")).join(" · ") || "Canva design")}${design.pageCount > 1 ? ` · ${design.pageCount} pages` : ""}</small><em>Updated ${design.updatedAt ? new Date(design.updatedAt * 1000).toLocaleDateString() : "recently"}</em></span></button>`).join("") : '<div class="empty">No Canva designs found.</div>';
    $$("[data-canva-id]").forEach(button => button.onclick = () => addCanvaDesign(data.designs.find(design => design.id === button.dataset.canvaId)));
  } catch (error) { host.innerHTML = `<div class="empty">${esc(error.message || "Canva designs could not be loaded")}</div>`; }
}
async function addCanvaDesign(design) {
  if (!design) return;
  const id = crypto.randomUUID();
  let mediaUrl = design.thumbnail || "/assets/brand-cover.jpg";
  let images = [mediaUrl];
  let contentType = Number(design.pageCount) > 1 ? "carousel" : "image";
  try {
    const data = await api("/api/canva/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ designId: design.id, pageCount: design.pageCount || 0, designTypes: design.designTypes || [], doctypeName: design.doctypeName || "" }) });
    mediaUrl = data.previewUrl || mediaUrl;
    images = Array.isArray(data.images) && data.images.length ? data.images : [mediaUrl];
    contentType = data.contentType || contentType;
  } catch (error) {
    return notify(error.message || "Canva design could not be imported");
  }
  const isCanvaVideo = contentType === "video";
  const post = { id, image: images[0] || mediaUrl, images, assetSource: "canva", canvaUrl: design.editUrl || design.viewUrl, canvaDesignId: design.id, canvaDoctypeName: design.doctypeName || "", canvaDesignTypes: design.designTypes || [], canvaAssetType: isCanvaVideo ? "video" : "image", canvaPageCount: design.pageCount || 0, assetKind: isCanvaVideo ? "video" : "image", cropRatio: "4:5", status: "draft", approval: "feedback", type: contentType === "carousel" ? "CAROUSEL" : isCanvaVideo ? "REEL" : "IMAGE", date: "", time: "", scheduleState: "draft", caption: "", notes: design.title, comments: [], updatedBy: currentUser.name, updatedAt: new Date().toISOString() };
  posts.unshift(post); selected = id; $("#canvaModal").classList.add("hidden"); renderAll();
  narrowOrFallback(() => api("/api/planner/assets", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ asset: post, actor: currentUser, reason: "added a Canva working draft" })
  }))
    .then(async result => {
      if (result.fallback) await persistPlanner("added a Canva working draft");
      else posts = replaceAsset(posts, result.data.asset);
      notify("Canva draft added");
    })
    .catch(error => { posts = posts.filter(item => item.id !== id); renderAll(); notify(error.message || "Canva draft could not be added"); });
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
$("#mobileMenuBtn").onclick = toggleMobileMenu;
$("#mobileMenuBackdrop").onclick = closeMobileMenu;
const mobileDrawerClose = $("#mobileDrawerClose");
if (mobileDrawerClose) mobileDrawerClose.onclick = closeMobileMenu;
document.addEventListener("keydown", event => { if (event.key === "Escape") closeMobileMenu(); });
$("#myTasksTab").onclick = () => { taskTab = "mine"; approvalDetail = null; renderTasks(); };
$("#teamTasksTab").onclick = () => { taskTab = "team"; approvalDetail = null; renderTasks(); };
$("#approvalsTab").onclick = () => { taskTab = "approvals"; approvalDetail = null; renderTasks(); };
$("#activityTab").onclick = () => { taskTab = "activity"; approvalDetail = null; renderTasks(); renderActivity(); };
$("#taskSort").onchange = () => renderTasks();
$("#activityFilters").onchange = () => { activityFilters = $$("#activityFilters input:checked").map(input => input.value); saveActivityFilters(currentUser, activityFilters); renderActivity(); };
let pendingUndo = null;
function openUndoConfirmation(activityId, button = null) {
  const item = activity.find(entry => entry.rollbackId === activityId);
  if (!item) return;
  pendingUndo = { activityId, button };
  $("#rollbackConfirmText").textContent = `This will undo: ${normalizeActivityText(item.text)}`;
  $("#rollbackConfirmModal").classList.remove("hidden");
  $("#confirmRollbackBtn").focus();
}
function closeUndoConfirmation() {
  pendingUndo = null;
  $("#rollbackConfirmModal").classList.add("hidden");
}
async function undoActivity(activityId, button = null) {
  if (!activityId) return;
  if (button) button.disabled = true;
  try {
    const result = await narrowOrFallback(() => api(`/api/activity/${encodeURIComponent(activityId)}/undo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: currentUser })
    }));
    if (result.fallback) {
      // Row storage isn't enabled — same legacy whole-document rollback as
      // before Task 8.
      const data = await api(`/api/planner/rollback/${encodeURIComponent(activityId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: plannerVersion })
      });
      setPlanner(data.planner);
      renderAll();
      notify("Activity undone");
      return;
    }
    // Row-storage undo only ever touches the one entity it's undoing —
    // never replace the whole local planner from this response.
    if (result.data.entityType === "asset") {
      posts = result.data.asset ? replaceAsset(posts, result.data.asset) : posts.filter(post => post.id !== result.data.entityId);
    } else if (result.data.entityType === "idea") {
      scratch = scratch.filter(entry => entry.id !== result.data.entityId);
    }
    renderAll();
    notify("Activity undone");
  } catch (error) {
    if (error.status === 409 && error.code === "UNDO_STALE") {
      notify("This item changed after that action and can no longer be safely undone.");
    } else {
      if (error.planner) setPlanner(error.planner);
      notify(error.message || "That activity could not be undone");
    }
    renderActivity();
  } finally {
    if (button) button.disabled = false;
  }
}
$("#activityList").onclick = event => {
  const button = event.target.closest("[data-rollback-id]");
  if (button) openUndoConfirmation(button.dataset.rollbackId, button);
};
$("#confirmRollbackBtn").onclick = () => {
  const request = pendingUndo;
  closeUndoConfirmation();
  if (request) undoActivity(request.activityId, request.button);
};
$("#cancelRollbackBtn").onclick = closeUndoConfirmation;
$("#closeRollbackConfirm").onclick = closeUndoConfirmation;
$("#rollbackConfirmModal").onclick = event => { if (event.target.id === "rollbackConfirmModal") closeUndoConfirmation(); };
document.addEventListener("keydown", event => {
  const target = event.target;
  const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable || target.closest?.("input, textarea, select, [contenteditable='true']");
  if (!event.metaKey || event.shiftKey || event.key.toLowerCase() !== "z" || editing) return;
  const latest = activity[0];
  if (!latest?.reversible || !latest.rollbackId) return;
  event.preventDefault();
  openUndoConfirmation(latest.rollbackId);
});
$("#prevMonth").onclick = () => { if (calendarView === "week") calCursor.setDate(calCursor.getDate() - 7); else if (calendarView === "year") calCursor.setFullYear(calCursor.getFullYear() - 1); else calCursor.setMonth(calCursor.getMonth() - 1); renderCalendar(); };
$("#todayMonth").onclick = () => { calCursor = new Date(); renderCalendar(); };
$("#nextMonth").onclick = () => { if (calendarView === "week") calCursor.setDate(calCursor.getDate() + 7); else if (calendarView === "year") calCursor.setFullYear(calCursor.getFullYear() + 1); else calCursor.setMonth(calCursor.getMonth() + 1); renderCalendar(); };
$$("[data-calendar-view]").forEach(button => button.onclick = () => { calendarView = button.dataset.calendarView; if (calendarView === "week") calCursor = new Date(); renderCalendar(); });
$("#calendarInstagramToggle").checked = calendarShowInstagram;
$("#calendarInstagramToggle").onchange = event => { calendarShowInstagram = event.target.checked; saveCalendarInstagramPreference(currentUser, calendarShowInstagram); renderCalendar(); };
$$(".chip").forEach(chip => chip.onclick = () => {
  libraryFilter = chip.dataset.filter;
  $$(".chip").forEach(item => item.classList.toggle("active", item === chip));
  renderLibrary();
});
$("#librarySearch").oninput = event => { librarySearch = event.target.value.trim(); renderLibrary(); };
$("#assetLibraryTab").onclick = () => setLibrarySection("assets");
$("#ideasTab").onclick = () => setLibrarySection("ideas");
$("#scratchForm").onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const existing = scratch.find(entry => entry.id === form.dataset.editing);
  const idea = scratchIdeaPayload({
    title: $("#scratchTitle").value,
    format: $("#scratchFormat") ? $("#scratchFormat").value : "",
    pillar: $("#scratchPillar") ? $("#scratchPillar").value : "",
    body: $("#scratchBody").value,
    images: scratchAttachedImages,
    image: $("#scratchImage").value,
    tags: $("#scratchTags").value,
    goal: $("#scratchGoal").value,
    hook: $("#scratchHook").value,
    cta: $("#scratchCta").value,
    comments: existing ? existing.comments : []
  });
  const title = idea.title;
  if (!title) return;
  const now = new Date().toISOString();
  let newEntry = null;
  if (existing) {
    Object.assign(existing, { ...idea, updatedBy: currentUser.name, updatedAt: now });
  } else {
    newEntry = { id: crypto.randomUUID(), ...idea, status: "active", createdBy: currentUser.name, updatedBy: currentUser.name, createdAt: now, updatedAt: now };
    scratch.unshift(newEntry);
  }
  form.reset();
  scratchAttachedImages = [];
  renderScratchPhotosTray();
  delete form.dataset.editing;
  form.querySelector('button[type="submit"]').textContent = "Save idea";
  const cancelBtn = $("#scratchCancelEdit");
  if (cancelBtn) cancelBtn.classList.add("hidden");
  renderScratch();
  if (existing) {
    await saveIdea(existing, idea, "updated an idea");
  } else {
    const result = await narrowOrFallback(() => api("/api/ideas", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea: newEntry, actor: currentUser, reason: "added an idea" })
    }));
    if (result.fallback) await persistPlanner("added an idea");
    else { Object.assign(newEntry, result.data.idea); newEntry.revision = result.data.revision; }
  }
  notify(existing ? "Idea updated" : "Idea saved");
};
const cancelEditBtn = $("#scratchCancelEdit");
if (cancelEditBtn) {
  cancelEditBtn.onclick = () => {
    const form = $("#scratchForm");
    form.reset();
    scratchAttachedImages = [];
    renderScratchPhotosTray();
    delete form.dataset.editing;
    form.querySelector('button[type="submit"]').textContent = "Save idea";
    cancelEditBtn.classList.add("hidden");
  };
}
if ($("#scratchPhotoInput")) {
  $("#scratchPhotoInput").onchange = async event => {
    const files = Array.from(event.target.files || []).filter(f => f.type.startsWith("image/"));
    if (!files.length) return;
    const statusEl = $("#scratchUploadStatus");
    if (statusEl) {
      statusEl.classList.remove("hidden");
      statusEl.textContent = `Uploading ${files.length} photo${files.length > 1 ? "s" : ""}…`;
    }
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (statusEl) statusEl.textContent = `Uploading photo ${i + 1} of ${files.length}…`;
        const uploadFile = await prepareUploadFile(file);
        if (uploadFile.size > 3 * 1024 * 1024) throw new Error("Photos must be under 3 MB");
        const uploaded = await api("/api/assets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: uploadFile.name, data: await readFile(uploadFile) })
        });
        if (uploaded?.url) {
          scratchAttachedImages.push(uploaded.url);
        }
      }
      renderScratchPhotosTray();
      if (statusEl) {
        statusEl.textContent = "Photos attached";
        setTimeout(() => statusEl.classList.add("hidden"), 2500);
      }
    } catch (err) {
      if (statusEl) statusEl.textContent = err.message || "Upload failed";
      notify(err.message || "Photo upload failed");
    } finally {
      event.target.value = "";
    }
  };
}

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
  if (!silent) setPageLoading(true);
  const syncButtons = [$("#settingsSync"), $("#modalSync")].filter(Boolean);
  if (!silent) {
    syncButtons.forEach(btn => {
      btn.disabled = true;
      btn.dataset.prevText = btn.textContent;
      btn.innerHTML = '<span class="button-spinner"></span>Syncing…';
    });
  }
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
    if (!silent) {
      notify(error.message);
      $("#settingsModal").classList.remove("hidden");
    }
  } finally {
    if (!silent) {
      setPageLoading(false);
      syncButtons.forEach(btn => {
        btn.disabled = false;
        if (btn.dataset.prevText) btn.textContent = btn.dataset.prevText;
      });
    }
  }
}

// The planner and Instagram connection live on the server. Periodic
// refreshes let teammates see each other's changes without sharing a
// browser session or relying on browser storage. Only poll while the tab is
// visible. The cadence adapts to what the last poll actually did: the
// row-storage change feed only ever transfers small deltas (or a 304 with
// no body), so it can safely run every 5 seconds; the legacy whole-document
// fallback (used until Task 9 turns row storage on) re-fetches the entire
// planner every time, which was the cause of a real Fast Origin Transfer
// overage at anything faster than 30 seconds — so a poll that falls back
// keeps that slower cadence instead of silently reintroducing it.
const PLANNER_POLL_DELTA_MS = 5000;
const PLANNER_POLL_FALLBACK_MS = 30000;
let plannerPollTimer = null;
function schedulePlannerPoll(delayMs) {
  clearTimeout(plannerPollTimer);
  plannerPollTimer = setTimeout(async () => {
    if (document.visibilityState !== "visible") {
      schedulePlannerPoll(PLANNER_POLL_DELTA_MS);
      return;
    }
    const outcome = await refreshSharedPlanner();
    schedulePlannerPoll(outcome === "fallback" ? PLANNER_POLL_FALLBACK_MS : PLANNER_POLL_DELTA_MS);
  }, delayMs);
}
schedulePlannerPoll(PLANNER_POLL_DELTA_MS);
setInterval(checkInstagram, 30000);
window.addEventListener("focus", () => { refreshSharedPlanner(); checkInstagram(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshSharedPlanner();
});

$("#modalSync").onclick = syncInstagram;
$("#saveSettings").onclick = async () => {
  const pillars = $("#settingsPillars").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const goals = $("#settingsGoals").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const formats = $("#settingsFormats").value.split(/\r?\n/).map(value => value.trim().toUpperCase()).filter(Boolean);
  if (!pillars.length || !formats.length) return notify("Add at least one pillar and one format");
  const workflowAutomations = Object.fromEntries($$("[data-automation-workflow]").map(select => [select.dataset.automationWorkflow, select.value]));
  const nextSettings = { pillars, formats, goals, syncPhotoCount: Math.min(100, Math.max(3, Number($("#settingsSyncCount").value) || 12)), workflowAutomations };
  const previousRevision = settings.revision || 1;
  settings = nextSettings;
  const result = await narrowOrFallback(() => api("/api/settings", {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: previousRevision, changes: nextSettings, actor: currentUser })
  }));
  if (result.fallback) {
    await persistPlanner("updated planner settings");
  } else {
    settings = result.data.settings;
    settings.revision = result.data.revision;
  }
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
$("#backToGrid").onclick = () => {
  if (editorSaveInProgress) return notify("Saving your changes…");
  switchView(editorReturnView);
};
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

$("#addTeamMemberBtn").onclick = () => openTeamMemberModal();
$("#closeTeamMemberModal").onclick = closeTeamMemberModal;
$("#cancelTeamMemberBtn").onclick = closeTeamMemberModal;
$("#teamMemberModal").onclick = event => { if (event.target.id === "teamMemberModal") closeTeamMemberModal(); };
$("#saveTeamMemberBtn").onclick = async () => {
  const id = $("#teamMemberId").value;
  const name = $("#teamMemberName").value.trim();
  const role = $("#teamMemberRole").value;
  const password = $("#teamMemberPassword").value;
  const errorEl = $("#teamMemberError");
  errorEl.classList.add("hidden");

  if (name.length < 2) {
    errorEl.textContent = "Please enter a display name (at least 2 characters).";
    errorEl.classList.remove("hidden");
    return;
  }
  if (!id && (!password || password.length < 8)) {
    errorEl.textContent = "Password must be at least 8 characters.";
    errorEl.classList.remove("hidden");
    return;
  }
  if (id && password && password.length < 8) {
    errorEl.textContent = "New password must be at least 8 characters.";
    errorEl.classList.remove("hidden");
    return;
  }

  try {
    const isEdit = Boolean(id);
    const url = isEdit ? `/api/team/members/${encodeURIComponent(id)}` : "/api/team/members";
    const method = isEdit ? "PUT" : "POST";
    const body = { name, role };
    if (password) body.password = password;

    await api(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    closeTeamMemberModal();
    notify(isEdit ? `Updated ${name}` : `Added ${name} to the team`);
    if (isEdit && currentUser && currentUser.id === id) {
      currentUser.name = name;
      currentUser.role = role;
      saveUser();
    }
    await loadPlanner();
    await loadTeamMembers();
    renderTeamSettings();
    renderAll();
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.classList.remove("hidden");
  }
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
  setPageLoading(true);
  renderAllSkeletons();
  try {
    await loadAccount();
    await loadPlanner();
    renderAll();
  } finally {
    setPageLoading(false);
  }
  checkInstagram().then(async () => {
    if (igStatus.connected && !initialInstagramSyncDone) {
      initialInstagramSyncDone = true;
      await syncInstagram({silent: true});
    }
  }).catch(() => {});
}

init().catch(error => {
  setPageLoading(false);
  notify(error.message || "Planner failed to load");
});
