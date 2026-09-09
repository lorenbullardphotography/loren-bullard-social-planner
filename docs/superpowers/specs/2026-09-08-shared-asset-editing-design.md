# Shared Asset Editing Design

## Goal

Make concurrent work in the planner safe by saving each asset independently, automatically merging edits to different fields, and requiring a deliberate choice only when two people change the same field.

## Scope

This design replaces planner-wide persistence for asset edits. It covers editable planned assets, their comments, workflow state, and media-related metadata. Planner settings, Scratch Book entries, Instagram sync data, and account settings remain on their existing save paths for this implementation.

## Current problem

The browser currently sends the complete planner document with one shared version number for every edit. A change to any post, setting, or comment increments that version. An editor can therefore receive a conflict even when another teammate changed an unrelated asset, and the browser must retry from a stale full-planner copy.

## Data model

Each stored post receives these fields:

- `revision`: positive integer, starting at `1` for existing and newly created posts.
- `fieldUpdatedAt`: object whose keys are editable field names and whose values are ISO timestamps.
- `fieldUpdatedBy`: object whose keys are editable field names and whose values are the editor’s display name.

The server treats the following as asset-editable fields: type, workflow, status, approval, assignee, priority, pillar, date, schedule state, caption, notes, audio, hashtags, tag notes, alt text, location, location tag, crop settings, and update metadata. Comments, reel covers, Canva previews, and asset media retain their dedicated flows and revisions.

Existing posts without these fields are normalized on read with `revision: 1` and empty field metadata. This keeps existing planner data compatible.

## API

### Update an asset

`PATCH /api/assets/:id`

Request body:

```json
{
  "revision": 4,
  "changes": {
    "caption": "Updated caption",
    "date": "2026-09-15"
  },
  "actor": { "name": "Loren", "role": "Photographer" }
}
```

Successful response: `200` with the fully normalized, updated asset.

The server validates the changed fields using the same limits and allowed values already used by `normalizePost`. It updates only those fields, records metadata for them, increments the asset revision, persists the planner, and returns that asset.

### Automatic merge response

If the submitted asset revision is older than the stored revision, the server compares every requested field with `fieldUpdatedAt`.

- If none of the requested fields changed after the submitted revision, it applies the requested fields to the latest asset and returns `200` with `merged: true`.
- If one or more requested fields changed after the submitted revision, it returns `409` with the latest asset and a `conflicts` object containing only those field names.

Example same-field conflict response:

```json
{
  "error": "This asset changed while you were editing it.",
  "asset": { "id": "...", "revision": 5 },
  "conflicts": {
    "caption": {
      "currentValue": "Teammate caption",
      "updatedBy": "Brooke",
      "updatedAt": "2026-09-08T20:00:00.000Z"
    }
  }
}
```

### Resolve a same-field conflict

The editor presents the latest value alongside the user’s value for each conflicted field.

- **Keep mine** resubmits that field with `forceFields: ["fieldName"]` and the latest returned revision.
- **Use latest** removes that field from the pending changes.

The server accepts `forceFields` only for fields included in `changes`; it applies the selected fields to the latest revision, tracks their editor metadata, and increments the revision. The response is `200` with the saved asset.

## Browser behavior

The asset editor captures a baseline asset revision and the initial values of editable fields when it opens. On Save, it builds a `changes` object containing only fields whose values differ from that baseline and sends the asset-level patch.

- If the response is successful, replace just that asset in local state, refresh visible views, notify the user, and return to the page that opened the editor.
- If the response was automatically merged, show the same success behavior with a brief “Saved alongside a teammate’s changes” message.
- If the response has same-field conflicts, keep the editor open and show an inline conflict panel. No local user input is discarded.
- Background refreshes replace only assets with newer revisions. They never overwrite a dirty editor.

The grid, calendar, library, task list, and approval views continue reading from the existing `posts` collection, so no visual re-architecture is required.

## Error handling

- Network or server errors leave the editor open with its values intact and restore the Save button.
- A deleted asset returns `404`; the editor closes with a message that the asset was removed by a teammate.
- Invalid fields return `400` with a readable message; the editor stays open.
- Two consecutive same-field conflict responses retain the newest server response and ask the user to choose again. The client never silently forces a field.

## Testing

Automated tests will cover:

1. Normalizing legacy posts with an initial asset revision.
2. Updating a single asset without changing unrelated posts or planner-wide versions.
3. Merging stale edits to different fields.
4. Returning structured conflicts for a stale edit to the same field.
5. Applying a user-approved forced field after a conflict.
6. Browser generation of minimal field changes and replacement of a single saved asset in local state.
7. Preserving dirty editor input when background refreshes deliver a newer unrelated asset.

## Non-goals

- Live cursor presence, typing indicators, and document-style simultaneous text editing.
- Per-field permissions or role-based editing rules.
- Moving the entire planner to a new database schema.
- Changing the UI of non-asset planner sections.
