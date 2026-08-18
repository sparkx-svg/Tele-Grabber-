# TeleGrab MTProto Backend

This replaces the old "guess the CDN URL" approach (which never actually
worked — `cdn.telegram.org` links are per-download, signed, and expire; they
can't be brute-forced) with a real Telegram **user login**. Once logged in,
the backend downloads media directly from Telegram's data centers and streams
it to your frontend. Limits are whatever your *account* allows: **2GB per
file, or 4GB if that account has Telegram Premium.**

## Why a backend is required
MTProto (Telegram's real client protocol) needs a persistent authenticated
connection and can't safely run in a static HTML/JS page — your API
credentials and login session would be exposed to anyone visiting the page.
So: small Node.js service holds the login session, your existing frontend
just calls it over HTTP.

## 1. Get API credentials (5 min, phone only, no terminal needed)
1. Go to **https://my.telegram.org/apps** on your phone/browser.
2. Log in with the Telegram account you want to download with.
3. Fill in the "Create new application" form (any app name/short name works).
4. Copy the **api_id** and **api_hash** shown.

## 2. Configure
Copy `.env.example` to `.env` and paste in your values:
```
API_ID=123456
API_HASH=abcdef0123456789abcdef0123456789
ALLOWED_ORIGIN=https://your-frontend-url.com
```

## 3. Deploy (no terminal required — all done in the browser)
Recommended: **Render.com** (free tier works, keeps a long-lived process —
required for MTProto's persistent connection; typical serverless platforms
like Vercel functions will NOT work here because they kill connections
between requests).

1. Push this `server/` folder to a GitHub repo (GitHub's web uploader works —
   drag the 4 files into a new repo, no terminal needed).
2. On Render.com: **New → Web Service** → connect that repo.
3. Build command: `npm install`  |  Start command: `npm start`
4. Add environment variables `API_ID`, `API_HASH`, `ALLOWED_ORIGIN` in
   Render's dashboard (same values as your `.env`).
5. Deploy. Render gives you a URL like `https://telegrab-backend.onrender.com`
   — that's your **Backend URL** for the frontend settings panel.

(Railway.app and Fly.io work the same way if you prefer those.)

## 4. Login flow (what the frontend does for you)
1. `POST /auth/start` `{ phone: "+91..." }` → Telegram texts/sends a login
   code to that account → returns `{ sessionId, needs: "code" }`.
2. `POST /auth/submit` `{ sessionId, field: "code", value: "12345" }`.
3. If the account has Two-Step Verification (2FA) on, you'll instead get
   `needs: "password"` → submit again with `field: "password"`.
4. Once `{ status: "logged_in" }` comes back, you can download.

## 5. Downloading
`GET /download?sessionId=...&link=https://t.me/channel/123` streams the raw
file bytes back with the correct filename — the frontend reads it exactly
like a normal fetch download (progress bar, pause/resume, SHA256 all keep
working as before).

## Notes & limits
- Only works for messages your logged-in account can actually see (public
  channels, or chats/groups you're a member of). It can't pull private media
  you don't have access to — that was never really possible even with the
  old CDN-guessing method.
- Sessions are stored in memory here for simplicity — restarting the backend
  logs everyone out. For production, persist `client.session.save()` (a
  string) somewhere safe per user and reload it with `new StringSession(saved)`.
- Never commit your `.env` / API_HASH to a public repo.
