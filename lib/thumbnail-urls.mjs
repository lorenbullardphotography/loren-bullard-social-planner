// Thumbnail convention: planner/<uuid>.<ext> -> planner/thumbs/<uuid>.jpg.
// public/app.js is a classic script that cannot import this module, so it
// carries a copy of thumbUrlFor; test/thumbnail-urls.test.mjs runs both
// against the same cases to keep them in agreement.
const ASSET_PREFIX = "planner/";
const THUMB_PREFIX = "planner/thumbs/";

export function thumbKeyFor(key) {
  const value = String(key || "");
  if (value.startsWith(THUMB_PREFIX)) return value;
  if (!value.startsWith(ASSET_PREFIX)) return "";
  const name = value.slice(ASSET_PREFIX.length).replace(/\.[^./]+$/, "");
  return name ? `${THUMB_PREFIX}${name}.jpg` : "";
}

export function thumbUrlFor(url) {
  let parsed;
  try { parsed = new URL(String(url || "")); } catch { return ""; }
  if (!/^https?:$/.test(parsed.protocol)) return "";
  const key = thumbKeyFor(parsed.pathname.replace(/^\//, ""));
  if (!key) return "";
  parsed.pathname = `/${key}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}
