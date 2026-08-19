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

// ---- In-memory session store -------------------------------------------
// sessions[sessionId] = { client, pending: {field: resolveFn}, loggedIn, needs, error }
// NOTE: in-memory means logins are lost on server restart. For a persistent
// setup, save `sessions[id].sessionString` to a small DB/file keyed by a
// user-chosen PIN and reload it with `new StringSession(savedString)`.
const sessions = {};

function waitFor(sessionId, field) {
  return new Promise((resolve) => {
    sessions[sessionId].pending[field] = resolve;
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
  sessions[sessionId] = { client, pending: {}, loggedIn: false, needs: 'code', error: null };

  try {
    await client.connect();

    // client.start() drives the full MTProto login flow (SendCode -> SignIn
    // -> CheckPassword if 2FA is on) and pauses on these callbacks whenever
    // it needs input from the user, which we supply via /auth/submit below.
    client
      .start({
        phoneNumber: async () => phone,
        phoneCode: async () => {
          sessions[sessionId].needs = 'code';
          return waitFor(sessionId, 'code');
        },
        password: async () => {
          sessions[sessionId].needs = 'password';
          return waitFor(sessionId, 'password');
        },
        onError: (err) => {
          sessions[sessionId].error = err.message;
        },
      })
      .then(() => {
        sessions[sessionId].loggedIn = true;
        sessions[sessionId].needs = null;
        sessions[sessionId].sessionString = client.session.save();
        console.log(`✅ Session ${sessionId} logged in.`);
      })
      .catch((err) => {
        sessions[sessionId].error = err.message;
      });

    // Give SendCode a moment to fire before responding.
    await new Promise((r) => setTimeout(r, 1500));
    res.json({ sessionId, needs: sessions[sessionId].needs, error: sessions[sessionId].error });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Step 2: submit the SMS/app code, and password if 2FA is enabled ----
app.post('/auth/submit', authLimiter, async (req, res) => {
  const { sessionId, field, value } = req.body || {}; // field: 'code' | 'password'
  const s = sessions[sessionId];
  if (!s) return res.status(404).json({ error: 'unknown or expired sessionId' });
  if (!s.pending[field]) {
    return res.status(400).json({ error: `not currently waiting for "${field}"`, needs: s.needs });
  }

  s.pending[field](value);
  delete s.pending[field];

  await new Promise((r) => setTimeout(r, 1500));

  if (s.error) return res.status(400).json({ error: s.error, needs: s.needs });
  if (s.loggedIn) return res.json({ status: 'logged_in', sessionString: s.sessionString });
  res.json({ status: 'pending', needs: s.needs });
});

// ---- Resume a previous login using a saved session string ---------------
// The frontend stores the sessionString (returned above) in localStorage.
// If the backend restarts (e.g. after a redeploy) and forgets the in-memory
// session, the frontend calls this to log back in instantly — no phone
// code needed, since the session string itself proves you're authorized.
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
    sessions[sessionId] = {
      client,
      pending: {},
      loggedIn: true,
      needs: null,
      error: null,
      sessionString,
    };
    console.log(`✅ Session ${sessionId} resumed from saved session string.`);
    res.json({ sessionId, status: 'logged_in', sessionString });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Poll login status ---------------------------------------------------
app.get('/auth/status', (req, res) => {
  const s = sessions[req.query.sessionId];
  if (!s) return res.status(404).json({ error: 'unknown sessionId' });
  res.json({ loggedIn: !!s.loggedIn, needs: s.needs, error: s.error });
});

// ---- Download: streams the real file straight from Telegram's DCs -------
// Works for anything up to the account's cap (2GB, or 4GB with Premium) —
// no more guessing cdn.telegram.org URLs, this pulls the actual media.
app.get('/download', downloadLimiter, async (req, res) => {
  const { sessionId, link } = req.query;
  const s = sessions[sessionId];
  if (!s || !s.loggedIn) return res.status(401).json({ error: 'not logged in' });

  const match = String(link || '').match(/t\.me\/(?:c\/)?([^/]+)\/(\d+)/);
  if (!match) return res.status(400).json({ error: 'link must look like https://t.me/channel/123' });
  const [, chatPart, msgIdStr] = match;
  const msgId = parseInt(msgIdStr, 10);

  try {
    const client = s.client;
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
  const s = sessions[req.body.sessionId];
  if (s) {
    try { await s.client.disconnect(); } catch (_) {}
    delete sessions[req.body.sessionId];
  }
  res.json({ status: 'ok' });
});

app.get('/', (_req, res) => res.send('TeleGrab MTProto backend is running.'));

app.listen(PORT, () => console.log(`🚀 TeleGrab MTProto backend listening on :${PORT}`));
