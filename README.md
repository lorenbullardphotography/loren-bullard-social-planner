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
- Meta access token is stored server-side instead of inside browser JavaScript
- Portable JSON backup export/import
- Optimistic concurrency protection so simultaneous edits do not silently overwrite each other
- Upload guardrails for large images

## Start the app

You need Node.js 18 or newer.

1. Unzip this folder.
2. Open Terminal.
3. Type `cd ` (include the space), then drag this folder into Terminal and press Return.
4. Run:

   node server.mjs

5. Open:

   http://localhost:8787

There are **no npm packages to install**.

## Connect @lorenbullardphotography to Instagram

See `META_SETUP.md`.

The app uses **Instagram API with Instagram Login**, intended for Instagram Professional accounts (Business or Creator).

Once connected, press **Sync Instagram**. The app fetches published media and places it below future planned posts.

## Privacy / security

- Do not share your `.env` file.
- Do not commit `.data/instagram-session.json` to GitHub.
- The app secret and Instagram access token are never stored in browser localStorage.
- The Instagram connection and planner data are shared server-side. Browser storage only remembers the display name and role for that browser; it does not store planner posts or Instagram credentials.
- To let you and your social media manager use it from separate computers, host this app on one reachable server and have both of you open that same URL. Running `localhost` on each computer creates two separate planners because each machine runs its own server/data folder.
- Set `PLANNER_PASSWORD` in `.env` before sharing the hosted URL. This adds a shared sign-in gate for you and your social media manager; each person can use the same password.
- For production hosting, use HTTPS and store `PLANNER_PASSWORD`, `INSTAGRAM_APP_SECRET`, and `INSTAGRAM_ACCESS_TOKEN` as private hosting environment variables.

## Publish the planner at your domain

The included `render.yaml` prepares the app for a Node host with persistent storage. Deploy the repository as a Render web service, add the environment values marked `sync: false`, and attach a subdomain such as `planner.yourdomain.com`. Render will provide HTTPS; add the resulting callback URL to Meta and set the same value as `INSTAGRAM_REDIRECT_URI`.

Do not use GitHub Pages for this app: it cannot run the server, protect the page with the password gate, or keep the Instagram token private.

## Optional future additions

- Shared cloud database + separate team logins
- Real-time commenting
- File upload storage in the cloud
- Meta content publishing/scheduling
- Scheduled Reel publishing
- Instagram insights
- Notifications when a post needs approval
- Canva asset links / import

## Current product boundaries

This is a strong planning and review workspace, but it is not yet a full publishing platform. Before relying on it as the system of record for a larger team, add durable cloud asset storage, individual user accounts/permissions, direct Meta publishing, timezone-aware scheduling, notifications, and platform analytics. The JSON backup in the top bar is the recommended safety net for the current local-file storage model.
