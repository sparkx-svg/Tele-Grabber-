// TeleGrab Pro — MTProto backend
// Logs in as a real Telegram USER ACCOUNT (not a bot) via GramJS, so downloads
// are limited by Telegram's account-side caps: 2GB normally, 4GB with Premium.
//
// Run locally:   npm install && npm start
// Deploy:        Render / Railway / Fly.io / any host that keeps a long-lived
//                Node process alive (NOT a one-shot serverless function —
//                MTProto needs a persistent TCP connection).

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { createSessionStore } = require('./store/sessionStore');

const API_ID = parseInt(process.env.API_ID, 10);
const API_HASH = process.env.API_HASH;
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

if (!API_ID || !API_HASH) {
  console.error('❌ Missing API_ID / API_HASH. Copy .env.example to .env and fill them in.');
  console.error('   Get them from https://my.telegram.org/apps');
  process.exit(1);
}

if (ALLOWED_ORIGIN === '*') {
  console.warn('⚠️  ALLOWED_ORIGIN is "*" — anyone on the internet can call this backend.');
  console.warn('⚠️  Set ALLOWED_ORIGIN to your actual frontend URL before sharing this publicly.');
}

const app = express();
app.set('trust proxy', 1); // needed on Render/Railway for rate-limit to see real client IPs

app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',') }));
// Body size cap — auth payloads are tiny (phone/code/password strings), so 10kb
// is generous headroom while still blocking someone trying to flood the process
// with an oversized request body.
app.use(express.json({ limit: '10kb' }));

// ---- Rate limiting on auth endpoints --------------------------------------
// Login attempts are the sensitive surface here: each /auth/start triggers a
// real Telegram SendCode call, and each /auth/submit is a guessable-code
// attempt. Cap both per IP so the backend (and the Telegram account behind
// it) can't be hammered.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,                   // 5 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait a few minutes and try again.' },
});

const downloadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,             // generous — legitimate bulk-grab usage still fits
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

// ---- Session storage --------------------------------------------------
// Two layers, deliberately kept separate:
//
// 1. `localClients` — live GramJS `TelegramClient` instances (real TCP
//    sockets) plus their pending phone-code/2FA-password resolvers. These
//    CANNOT be serialized or shared across processes, so they always live
//    in this process's memory, regardless of store backend.
//
// 2. `store` — the account-status metadata (loggedIn / needs / error /
//    sessionString) that decides what the frontend sees. This is the part
//    that's pluggable: `createSessionStore()` returns an in-memory Map by
//    default, or a Redis-backed store when REDIS_URL is set, so status
//    checks survive a restart and work across multiple instances behind a
//    load balancer. If a request lands on an instance that doesn't hold the
//    live client for a `loggedIn` session (e.g. after a redeploy, or a
//    different instance than the one that ran /auth/start), the route below
//    tells the frontend to call /auth/resume — which the frontend already
//    does automatically using the saved (encrypted) session string.
const localClients = new Map(); // sessionId -> { client, pending: {field: resolveFn} }
const store = createSessionStore();

function waitFor(sessionId, field) {
  return new Promise((resolve) => {
    localClients.get(sessionId).pending[field] = resolve;
  });
}

// ---- Step 1: begin login with a phone number ----------------------------
app.post('/auth/start', authLimiter, async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone is required, e.g. +919876543210' });

  const sessionId = crypto.randomUUID();
  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
    connectionRetries: 5,
  });
  localClients.set(sessionId, { client, pending: {} });

  const meta = { loggedIn: false, needs: 'code', error: null, sessionString: null };
  await store.set(sessionId, meta);

  try {
    await client.connect();

    // client.start() drives the full MTProto login flow (SendCode -> SignIn
    // -> CheckPassword if 2FA is on) and pauses on these callbacks whenever
    // it needs input from the user, which we supply via /auth/submit below.
    client
      .start({
        phoneNumber: async () => phone,
        phoneCode: async () => {
          meta.needs = 'code';
          await store.set(sessionId, meta);
          return waitFor(sessionId, 'code');
        },
        password: async () => {
          meta.needs = 'password';
          await store.set(sessionId, meta);
          return waitFor(sessionId, 'password');
        },
        onError: async (err) => {
          meta.error = err.message;
          await store.set(sessionId, meta);
        },
      })
      .then(async () => {
        meta.loggedIn = true;
        meta.needs = null;
        meta.sessionString = client.session.save();
        await store.set(sessionId, meta);
        console.log(`✅ Session ${sessionId} logged in.`);
      })
      .catch(async (err) => {
        meta.error = err.message;
        await store.set(sessionId, meta);
      });

    // Give SendCode a moment to fire before responding.
    await new Promise((r) => setTimeout(r, 1500));
    res.json({ sessionId, needs: meta.needs, error: meta.error });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Step 2: submit the SMS/app code, and password if 2FA is enabled ----
app.post('/auth/submit', authLimiter, async (req, res) => {
  const { sessionId, field, value } = req.body || {}; // field: 'code' | 'password'
  const local = localClients.get(sessionId);
  const meta = await store.get(sessionId);
  if (!local || !meta) return res.status(404).json({ error: 'unknown or expired sessionId' });
  if (!local.pending[field]) {
    return res.status(400).json({ error: `not currently waiting for "${field}"`, needs: meta.needs });
  }

  local.pending[field](value);
  delete local.pending[field];

  await new Promise((r) => setTimeout(r, 1500));

  const updated = await store.get(sessionId);
  if (updated.error) return res.status(400).json({ error: updated.error, needs: updated.needs });
  if (updated.loggedIn) return res.json({ status: 'logged_in', sessionString: updated.sessionString });
  res.json({ status: 'pending', needs: updated.needs });
});

// ---- Resume a previous login using a saved session string ---------------
// The frontend stores the sessionString (returned above) in localStorage.
// If the backend forgot this session (restart, redeploy, or a request that
// landed on a different instance), the frontend calls this to log back in
// instantly — no phone code needed, since the session string itself proves
// you're authorized.
app.post('/auth/resume', authLimiter, async (req, res) => {
  const { sessionString } = req.body || {};
  if (!sessionString) return res.status(400).json({ error: 'sessionString is required' });

  const sessionId = crypto.randomUUID();
  const client = new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, {
    connectionRetries: 5,
  });

  try {
    await client.connect();
    const authorized = await client.isUserAuthorized();
    if (!authorized) {
      await client.disconnect();
      return res.status(401).json({ error: 'Saved session is no longer valid — please log in again.' });
    }
    localClients.set(sessionId, { client, pending: {} });
    await store.set(sessionId, { loggedIn: true, needs: null, error: null, sessionString });
    console.log(`✅ Session ${sessionId} resumed from saved session string.`);
    res.json({ sessionId, status: 'logged_in', sessionString });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Poll login status ---------------------------------------------------
app.get('/auth/status', async (req, res) => {
  const meta = await store.get(req.query.sessionId);
  if (!meta) return res.status(404).json({ error: 'unknown sessionId' });
  res.json({ loggedIn: !!meta.loggedIn, needs: meta.needs, error: meta.error });
});

// ---- Download: streams the real file straight from Telegram's DCs -------
// Works for anything up to the account's cap (2GB, or 4GB with Premium) —
// no more guessing cdn.telegram.org URLs, this pulls the actual media.
app.get('/download', downloadLimiter, async (req, res) => {
  const { sessionId, link } = req.query;
  const meta = await store.get(sessionId);
  if (!meta || !meta.loggedIn) return res.status(401).json({ error: 'not logged in' });

  const local = localClients.get(sessionId);
  if (!local) {
    // Metadata says logged in, but this instance doesn't hold the live
    // client (e.g. after a redeploy, or a different instance behind a load
    // balancer handled the login). The frontend already knows how to
    // recover from this via /auth/resume using its saved session string.
    return res.status(409).json({
      error: 'Session not active on this server instance. Call /auth/resume with the saved session string and retry.',
    });
  }

  const match = String(link || '').match(/t\.me\/(?:c\/)?([^/]+)\/(\d+)/);
  if (!match) return res.status(400).json({ error: 'link must look like https://t.me/channel/123' });
  const [, chatPart, msgIdStr] = match;
  const msgId = parseInt(msgIdStr, 10);

  try {
    const client = local.client;
    const entityRef = /^\d+$/.test(chatPart) ? Number(chatPart) : chatPart;
    const entity = await client.getEntity(entityRef);
    const messages = await client.getMessages(entity, { ids: [msgId] });
    const msg = messages[0];

    if (!msg || !msg.media) {
      return res.status(404).json({ error: 'that message has no downloadable media' });
    }

    const fileName = (msg.file && msg.file.name) || `telegram_${msgId}.bin`;
    const size = msg.file ? msg.file.size : undefined;

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    if (size) res.setHeader('Content-Length', size.toString());

    // Streams chunk by chunk — never buffers the whole file in RAM.
    // NOTE: workers > 1 previously caused file corruption on large files —
    // parallel chunks can arrive out of order during reassembly, silently
    // producing a wrong-but-same-size file (e.g. a "zip" that's actually
    // scrambled bytes a viewer falls back to showing as text). Correctness
    // matters more than the speed gain, so this stays sequential (workers: 1).
    let bytesSent = 0;
    for await (const chunk of client.iterDownload({
      file: msg.media,
      requestSize: 1024 * 1024, // 1MB per chunk
      workers: 1,               // sequential — guarantees correct byte order
    })) {
      bytesSent += chunk.length;
      const ok = res.write(chunk);
      if (!ok) await new Promise((r) => res.once('drain', r));
    }

    // Integrity check: if what we actually streamed doesn't match the size
    // Telegram reported, something went wrong mid-download — better to end
    // the connection abnormally (browser will show a failed/incomplete
    // download) than silently hand over a truncated or corrupt file.
    if (size && bytesSent !== size) {
      console.error(`Size mismatch for msg ${msgId}: expected ${size}, got ${bytesSent}`);
      res.destroy(); // abort — do not let the client think this succeeded
      return;
    }

    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// ---- Log out / drop a session --------------------------------------------
app.post('/auth/logout', async (req, res) => {
  const { sessionId } = req.body || {};
  const local = localClients.get(sessionId);
  if (local) {
    try { await local.client.disconnect(); } catch (_) {}
    localClients.delete(sessionId);
  }
  await store.delete(sessionId);
  res.json({ status: 'ok' });
});

app.get('/', (_req, res) => res.send('TeleGrab MTProto backend is running.'));

app.listen(PORT, () => console.log(`🚀 TeleGrab MTProto backend listening on :${PORT}`));
