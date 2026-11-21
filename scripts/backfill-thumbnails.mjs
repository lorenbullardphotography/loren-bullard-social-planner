#!/usr/bin/env node
// One-off: create the planner/thumbs/<uuid>.jpg thumbnail for every existing
// image upload that lacks one, so tiles stop downloading full-size originals.
//
//   node --env-file=.env scripts/backfill-thumbnails.mjs              # dry run
//   node --env-file=.env scripts/backfill-thumbnails.mjs --apply      # create thumbnails
//   ... --limit 25                                                    # first 25 only
//
// Needs BLOB_READ_WRITE_TOKEN and a store that is not blocked. Safe to re-run:
// finished images already have a thumbnail and are skipped.
import { pathToFileURL } from "node:url";
import { thumbKeyFor } from "../lib/thumbnail-urls.mjs";

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp)$/i;
const MIN_SOURCE_BYTES = 150 * 1024;
const THUMB_EDGE = 640;
const ONE_YEAR_SECONDS = 31536000;

export function planThumbnails(blobs) {
  const existing = new Set(blobs.map(blob => blob.pathname));
  return blobs
    .filter(blob => blob.pathname.startsWith("planner/")
      && !blob.pathname.startsWith("planner/thumbs/")
      && IMAGE_EXTENSIONS.test(blob.pathname)
      && blob.size >= MIN_SOURCE_BYTES)
    .map(blob => ({ ...blob, thumbPathname: thumbKeyFor(blob.pathname) }))
    .filter(item => item.thumbPathname && !existing.has(item.thumbPathname));
}

async function listAll(client) {
  const blobs = [];
  let cursor;
  do {
    const page = await client.list({ prefix: "planner/", ...(cursor ? { cursor } : {}) });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);
  return blobs;
}

async function main(argv) {
  const apply = argv.includes("--apply");
  const limitIndex = argv.indexOf("--limit");
  const limit = limitIndex >= 0 ? Math.max(1, Number(argv[limitIndex + 1]) || 0) : Infinity;
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN is not set.");
  const client = await import("@vercel/blob");
  const plan = planThumbnails(await listAll(client)).slice(0, limit);
  const totalBytes = plan.reduce((sum, item) => sum + item.size, 0);
  console.log(`${plan.length} image(s) need a thumbnail (${(totalBytes / 1024 / 1024).toFixed(1)} MB to read).`);
  if (!apply) { console.log("Dry run. Re-run with --apply to create them."); return; }
  const { default: sharp } = await import("sharp");
  let done = 0, failed = 0;
  for (const item of plan) {
    try {
      const response = await fetch(item.url);
      if (!response.ok) throw new Error(`download failed (${response.status})`);
      const thumb = await sharp(Buffer.from(await response.arrayBuffer()))
        .rotate()
        .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      await client.put(item.thumbPathname, thumb, {
        access: "public", contentType: "image/jpeg", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: ONE_YEAR_SECONDS
      });
      done++;
      console.log(`ok   ${item.pathname} -> ${item.thumbPathname} (${(thumb.length / 1024).toFixed(0)} KB)`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${item.pathname}: ${error.message}`);
    }
  }
  console.log(`Done: ${done} created, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exit(1); });
}
