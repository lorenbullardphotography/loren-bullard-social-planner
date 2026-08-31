# Meta + Instagram Setup for @lorenbullardphotography

This planner is prepared for Meta's **Instagram API with Instagram Login**.

## Before you begin

`@lorenbullardphotography` needs to be an Instagram **Professional account** (Business or Creator).

## 1. Create / choose a Meta developer app

Go to the Meta for Developers dashboard and create an app suitable for the Instagram API. Meta's current Instagram documentation recommends a Business app for this use case.

Add the Instagram product / API setup that uses **Instagram Login**.

## 2. Configure Business Login for Instagram

In the Instagram API setup, configure the OAuth redirect URI exactly as:

    http://localhost:8787/auth/instagram/callback

If Meta will not accept a local HTTP redirect for your app configuration, deploy the planner to an HTTPS URL and replace this value with your hosted callback URL.

The planner requests only:

    instagram_business_basic

That is enough for the planner's read/sync use case.

If we later add direct publishing/scheduling, we can also request:

    instagram_business_content_publish

## 3. Copy your credentials

In this folder, make a copy of:

    .env.example

Rename the copy:

    .env

Fill in:

    INSTAGRAM_APP_ID=your_app_id
    INSTAGRAM_APP_SECRET=your_app_secret

Leave:

    INSTAGRAM_REDIRECT_URI=http://localhost:8787/auth/instagram/callback

unless you are hosting the app elsewhere.

## 4. Start the planner

In Terminal:

    node server.mjs

Then open:

    http://localhost:8787

Choose **Instagram settings → Connect Instagram**.

Sign into / authorize **@lorenbullardphotography**.

After authorization, the app exchanges the short-lived login token for a long-lived Instagram token on the server and immediately syncs your published media.

## 5. Token lifecycle

Instagram Login access tokens from the login flow are short-lived initially. This project exchanges the token for a long-lived token. Meta currently documents long-lived Instagram tokens at roughly 60 days and provides a refresh endpoint for eligible unexpired long-lived tokens.

The server includes:

    POST /api/instagram/refresh

For a hosted production version, schedule token refresh before expiration and store the token in a proper encrypted secret/database rather than a local JSON file.

## What the sync imports

The app requests these published-media fields when available:

- id
- caption
- media_type
- media_url
- thumbnail_url
- permalink
- timestamp

Reels use their thumbnail when Meta provides one.

## If the account does not appear

Check that:

1. @lorenbullardphotography is Business or Creator.
2. You authorized the correct Instagram account.
3. Your exact redirect URI is registered in the Meta app.
4. The Meta app/user setup allows your Instagram account to test/use the app while it is in development mode.
5. The `.env` App ID and App Secret are from the Instagram app you configured.

## Important

Never paste your Meta App Secret or access token into the browser UI, a public repository, or a message you do not intend to treat as secret.
