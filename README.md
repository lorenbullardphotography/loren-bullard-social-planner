# Loren Bullard Photography — Content Planner v2

A Planoly/Planable-style local content planner customized for **@lorenbullardphotography**.

## Version 2 features

- Instagram-style 3-column feed preview
- Drag-and-drop future posts
- Live Instagram connection status
- **Sync already-published Instagram content through Meta's Instagram API**
- Calendar view
- Content library
- Draft / Needs Review / Approved workflow
- Team feedback/comments on planned content
- Post format: Image / Reel / Carousel
- Caption, notes, and publish-date fields
- Published posts stay locked beneath future content
- Synced Instagram captions, timestamps, formats, thumbnails, and permalinks
- Server-side shared planner data, available to every browser using the same planner URL
- Individual named accounts for Loren and the social media manager
- Account sessions and passwords stored server-side; each account can update its name and role
- Meta access token is stored server-side instead of inside browser JavaScript
- Portable JSON backup export/import
- Optimistic concurrency protection so simultaneous edits do not silently overwrite each other
- Upload guardrails for large images
- Canva working-draft links, with optional server-side preview refresh

## Start the app

You need Node.js 18 or newer.

1. Unzip this folder.
2. Open Terminal.
3. Type `cd ` (include the space), then drag this folder into Terminal and press Return.
4. Run:

   node server.mjs

5. Open:

   http://localhost:8787

For local use, no packages are required unless you set `DATABASE_URL`. Vercel installs the listed dependency during deployment.

## Connect @lorenbullardphotography to Instagram

See `META_SETUP.md`.

The app uses **Instagram API with Instagram Login**, intended for Instagram Professional accounts (Business or Creator).

Once connected, press **Sync Instagram**. The app fetches published media and places it below future planned posts.

## Privacy / security

- Do not share your `.env` file.
- Do not commit `.data/instagram-session.json` to GitHub.
- The app secret and Instagram access token are never stored in browser localStorage.
- The Instagram connection, planner data, and user accounts are shared server-side. Browser storage is only a convenience cache; it does not store planner posts or Instagram credentials.
- To let you and your social media manager use it from separate computers, host this app on one reachable server and have both of you open that same URL. Running `localhost` on each computer creates two separate planners because each machine runs its own server/data folder.
- When the account store is empty, the app creates Loren (Photographer) and Brooke (Social Media Manager) automatically. The initial password for both accounts is `admin`; change it before sharing the hosted URL publicly.
- Both accounts see the same planner and Instagram connection when they use the same hosted URL.
- Existing deployments may use `PLANNER_PASSWORD` for the first Loren sign-in; after that, named accounts are used.
- For production hosting, use HTTPS and store `PLANNER_PASSWORD`, `INSTAGRAM_APP_SECRET`, and `INSTAGRAM_ACCESS_TOKEN` as private hosting environment variables.

## Publish the planner on Vercel

Vercel deploys the app from GitHub automatically. This repository includes the Vercel routing adapter in `api/index.mjs` and `vercel.json`.

For durable shared data, connect a Supabase Postgres database through Vercel's Marketplace. The integration supplies the database connection variables automatically. The app accepts `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, or `DATABASE_URL`.

Also add these environment variables in the Vercel project:

- `INSTAGRAM_APP_ID`
- `INSTAGRAM_APP_SECRET`
- `INSTAGRAM_REDIRECT_URI` (your production HTTPS callback URL)
- `PLANNER_PASSWORD` (optional legacy first-account migration)
- `AUTH_SECRET` (optional when `PLANNER_PASSWORD` is set, but recommended)

Set the Meta callback URL to:

`https://your-planner-domain.com/auth/instagram/callback`

The local JSON files remain available as a development fallback when `DATABASE_URL` is absent.

## Connect Canva working drafts

The planner supports adding a Canva design link without exporting or uploading a file. Click **Add Canva draft**, paste the design link, and use **Open in Canva** from the post editor. The link is shared with the whole planner team.

For automatic image previews, create a Canva Connect integration in the Canva Developer Portal and add these private environment variables to the server:

- `CANVA_CLIENT_ID`
- `CANVA_CLIENT_SECRET`
- `CANVA_REDIRECT_URI` (for example, `https://your-planner-domain.com/auth/canva/callback`)

The Canva integration must allow the `design:content:read` scope. Then open Planner settings and choose **Connect Canva**. The planner can generate a fresh JPG preview from a linked design; the original Canva file remains the working source.

Each signed-in planner user authorizes Canva separately. The planner stores each user's access and refresh tokens server-side under that user's account, refreshes access tokens when needed, and uses the signed-in user’s Canva connection for preview exports.

## Publish the planner at your domain

The included `render.yaml` is retained as an alternative for a traditional Node host with persistent storage. It is not needed for Vercel.

Do not use GitHub Pages for this app: it cannot run the server, protect the page with the password gate, or keep the Instagram token private.

## Optional future additions

- Granular team permissions and invitations
- Real-time commenting
- File upload storage in the cloud
- Meta content publishing/scheduling
- Scheduled Reel publishing
- Instagram insights
- Notifications when a post needs approval
- Automatic Canva asset preview refresh (implemented; requires Canva Connect credentials)

## Current product boundaries

This is a strong planning and review workspace, but it is not yet a full publishing platform. Before relying on it as the system of record for a larger team, add durable cloud asset storage, granular user permissions, direct Meta publishing, timezone-aware scheduling, notifications, and platform analytics. The JSON backup in the top bar is the recommended safety net for the current local-file storage model.
