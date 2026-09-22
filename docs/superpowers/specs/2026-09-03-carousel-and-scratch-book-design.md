# Carousel Navigation and Scratch Book Design

## Goals

1. Canva carousel assets retain all exported page images and expose previous/next navigation wherever the asset is previewed.
2. The planner gains a shared Scratch Book for ideas that are not yet planned assets.

## Carousel design

Carousel posts add an `images` array while keeping `image` as the first-page cover for backwards compatibility. Canva refresh/import exports the supported pages as JPGs and persists every returned URL. Existing single-image records continue to work unchanged.

The grid and library show the first page. The asset editor shows a bounded preview with previous/next arrows, a `current / total` counter, keyboard-accessible buttons, and no autoplay. Navigation is local UI state and does not mutate the post until a separate save/persist operation.

## Scratch Book design

Scratch entries are shared records separate from `posts`, with `id`, `title`, `body`, `image`, `tags`, `status` (`active` or `archived`), `createdBy`, `updatedBy`, `createdAt`, and `updatedAt`. They are included in the planner API/backup but excluded from post counts, scheduling, approvals, and Instagram sync.

The sidebar gets a Scratch Book view. It contains a create form and a card list with title, notes, optional image upload, tags, archive, edit, and delete actions. Changes use the existing optimistic persistence/version flow and activity tracking.

## Constraints

- Use the existing Node HTTP server, browser JavaScript, CSS, and JSON/database store; add no dependencies.
- Preserve old posts that only have `image` and no `images` array.
- Reuse existing upload limits and optimistic concurrency behavior.
- Keep all controls keyboard accessible and label arrows with their action.
