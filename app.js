// TeleGrab Pro — MTProto backend (Express app factory)
//
// Split out of server.js so the auth flow can be integration-tested by
// injecting a fake TelegramClient/StringSession instead of needing a real
// Telegram account, API credentials, and network access. server.js is now a
// thin entry point that calls createApp() with the real GramJS classes and
// starts listening; tests call createApp() directly with fakes.

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const {
  JSON_BODY_LIMIT,
  AUTH_RATE_LIMIT_WINDOW_MS,
  AUTH_RATE_LIMIT_MAX,
  DOWNLOAD_RATE_LIMIT_WINDOW_MS,
  DOWNLOAD_RATE_LIMIT_MAX,
  CLIENT_CONNECTION_RETRIES,
  CONNECT_RETRY_ATTEMPTS,
  CONNECT_RETRY_BASE_DELAY_MS,
  AUTH_SETTLE_DELAY_MS,
  DOWNLOAD_CHUNK_SIZE_BYTES,
} = require('./constants');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// GramJS's TelegramClient already retries at the TCP layer (connectionRetries
// passed to its constructor), but that only covers reconnecting an
// established client — it doesn't cover the initial client.connect() call
// itself failing outright (e.g. a transient DNS blip talking to Telegram's
// DCs). Wrap that specific call with a small extra retry so a one-off
// network hiccup during login doesn't force the user to start the whole
// phone-number flow over.
async function connectWithRetry(client, { retries = CONNECT_RETRY_ATTEMPTS, baseDelayMs = CONNECT_RETRY_BASE_DELAY_MS } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await client.connect();
      return;
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const delay = baseDelayMs * 2 ** attempt;
      console.warn(`⚠️  client.connect() failed (attempt ${attempt + 1}/${retries + 1}): ${err.message} — retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * The two values /auth/submit ever expects for `field`. Kept as an explicit
 * union (enforced below, and checked by `npm run typecheck` via JSDoc) so a
 * frontend/backend naming mismatch — e.g. the frontend sending `"pin"`
 * instead of `"password"` — fails loudly as a 400 instead of silently
 * hanging forever waiting on a pending[field] that's never set.
 * @typedef {'code' | 'password'} AuthField
 */
const VALID_AUTH_FIELDS = /** @type {const} */ (['code', 'password']);

/**
 * @param {object} deps
 * @param {number} deps.apiId
 * @param {string} deps.apiHash
 * @param {string} [deps.allowedOrigin]
 * @param {new (...args: any[]) => any} deps.TelegramClientClass - injectable so tests can pass a fake instead of GramJS's real TelegramClient
 * @param {new (...args: any[]) => any} deps.StringSessionClass - injectable so tests can pass a fake instead of GramJS's real StringSession
 * @param {{ get(id: string): Promise<any>, set(id: string, val: any): Promise<void>, delete(id: string): Promise<void> }} deps.store
 * @returns {import('express').Express}
 */
function createApp({ apiId, apiHash, allowedOrigin = '*', TelegramClientClass, StringSessionClass, store }) {
  if (!apiId || !apiHash) {
    throw new Error('createApp requires apiId and apiHash');
  }
  if (!TelegramClientClass || !StringSessionClass) {
    throw new Error('createApp requires TelegramClientClass and StringSessionClass');
  }
  if (!store) {
    throw new Error('createApp requires a session store');
  }

  const app = express();
  app.set('trust proxy', 1); // needed on Render/Railway for rate-limit to see real client IPs

  app.use(cors({ origin: allowedOrigin === '*' ? true : allowedOrigin.split(',') }));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  const authLimiter = rateLimit({
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    max: AUTH_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please wait a few minutes and try again.' },
  });

  const downloadLimiter = rateLimit({
    windowMs: DOWNLOAD_RATE_LIMIT_WINDOW_MS,
    max: DOWNLOAD_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.' },
  });

  // ---- Session storage --------------------------------------------------
  // Two layers, deliberately kept separate:
  //
  // 1. `localClients` — live TelegramClient instances (real TCP sockets, in
  //    production) plus their pending phone-code/2FA-password resolvers.
  //    These CANNOT be serialized or shared across processes, so they
  //    always live in this process's memory, regardless of store backend.
  //
  // 2. `store` — the account-status metadata (loggedIn / needs / error /
  //    sessionString) that decides what the frontend sees. This is the part
  //    that's pluggable: in-memory Map by default, or Redis-backed when
  //    REDIS_URL is set (see store/sessionStore.js), so status checks
  //    survive a restart and work across multiple instances behind a load
  //    balancer.
  const localClients = new Map(); // sessionId -> { client, pending: {field: resolveFn} }

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
    const client = new TelegramClientClass(new StringSessionClass(''), apiId, apiHash, {
      connectionRetries: CLIENT_CONNECTION_RETRIES,
    });
    localClients.set(sessionId, { client, pending: {} });

    const meta = { loggedIn: false, needs: 'code', error: null, sessionString: null };
    await store.set(sessionId, meta);

    try {
      await connectWithRetry(client);

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
          // This runs detached from the /auth/start request (which already
          // responded) — if store.set() itself throws here (e.g. Redis
          // hiccup), that would otherwise become a second, harder-to-trace
          // unhandled rejection. Wrap it so a storage failure just gets
          // logged instead of taking the process's crash-safety net with it.
          try {
            meta.error = err.message;
            await store.set(sessionId, meta);
          } catch (storeErr) {
            console.error(`⚠️  Failed to persist login error for session ${sessionId}:`, storeErr);
          }
        });

      // Give SendCode a moment to fire before responding.
      await sleep(AUTH_SETTLE_DELAY_MS);
      res.json({ sessionId, needs: meta.needs, error: meta.error });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Step 2: submit the SMS/app code, and password if 2FA is enabled ----
  app.post('/auth/submit', authLimiter, async (req, res) => {
    /** @type {{ sessionId?: string, field?: AuthField, value?: string }} */
    const { sessionId, field, value } = req.body || {};

    if (!VALID_AUTH_FIELDS.includes(field)) {
      return res.status(400).json({ error: `field must be one of: ${VALID_AUTH_FIELDS.join(', ')}` });
    }

    const local = localClients.get(sessionId);
    const meta = await store.get(sessionId);
    if (!local || !meta) return res.status(404).json({ error: 'unknown or expired sessionId' });
    if (!local.pending[field]) {
      return res.status(400).json({ error: `not currently waiting for "${field}"`, needs: meta.needs });
    }

    local.pending[field](value);
    delete local.pending[field];

    await sleep(AUTH_SETTLE_DELAY_MS);

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
    const client = new TelegramClientClass(new StringSessionClass(sessionString), apiId, apiHash, {
      connectionRetries: CLIENT_CONNECTION_RETRIES,
    });

    try {
      await connectWithRetry(client);
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

      // ---- Range support: lets the frontend resume a dropped download -----
      // instead of re-pulling the whole file from Telegram's DCs from byte 0.
      // Only single "bytes=start-" (or "bytes=start-end") ranges are honored
      // — that's the only shape the frontend's resume logic ever sends.
      let startByte = 0;
      let isPartial = false;
      const rangeHeader = req.headers.range;
      if (rangeHeader && size) {
        const rangeMatch = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
        if (!rangeMatch) {
          res.setHeader('Content-Range', `bytes */${size}`);
          return res.status(416).json({ error: 'Malformed Range header' });
        }
        startByte = parseInt(rangeMatch[1], 10);
        if (startByte >= size) {
          res.setHeader('Content-Range', `bytes */${size}`);
          return res.status(416).json({ error: 'Range start is beyond the end of the file' });
        }
        isPartial = true;
      }

      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      if (size) {
        res.setHeader('Content-Length', (size - startByte).toString());
        if (isPartial) {
          res.status(206);
          res.setHeader('Content-Range', `bytes ${startByte}-${size - 1}/${size}`);
        }
      }

      // Streams chunk by chunk — never buffers the whole file in RAM.
      // NOTE: workers > 1 previously caused file corruption on large files —
      // parallel chunks can arrive out of order during reassembly, silently
      // producing a wrong-but-same-size file (e.g. a "zip" that's actually
      // scrambled bytes a viewer falls back to showing as text). Correctness
      // matters more than the speed gain, so this stays sequential (workers: 1).
      // NOTE: `offset` here assumes GramJS's iterDownload() accepts a bigint
      // byte offset to start mid-file (true as of the `telegram` version
      // pinned in package.json). If a future GramJS upgrade changes that
      // option's name/shape, resumed downloads would fall back to re-sending
      // from byte 0 rather than corrupting anything — worth a smoke test
      // against a mid-download disconnect after bumping the dependency.
      // Diagnostic only: logs RSS every ~50MB transferred so a memory-capped
      // host (e.g. a 256MB free-tier container) shows a clear trend in its
      // log viewer leading up to a mid-download failure — confirms whether
      // the process is genuinely running out of room versus something else
      // (a network drop, a host timeout) killing the connection instead.
      const MEMORY_LOG_INTERVAL_BYTES = 50 * BYTES_PER_MB;
      let bytesSinceLastMemLog = 0;

      let bytesSent = 0;
      for await (const chunk of client.iterDownload({
        file: msg.media,
        offset: startByte ? BigInt(startByte) : undefined, // resume mid-file when a Range was requested
        requestSize: DOWNLOAD_CHUNK_SIZE_BYTES,
        workers: 1, // sequential — guarantees correct byte order
      })) {
        bytesSent += chunk.length;
        bytesSinceLastMemLog += chunk.length;
        if (bytesSinceLastMemLog >= MEMORY_LOG_INTERVAL_BYTES) {
          bytesSinceLastMemLog = 0;
          const mem = process.memoryUsage();
          console.log(
            `📊 download progress: ${(bytesSent / BYTES_PER_MB).toFixed(0)}MB sent — RSS ${(mem.rss / BYTES_PER_MB).toFixed(0)}MB, heapUsed ${(mem.heapUsed / BYTES_PER_MB).toFixed(0)}MB`,
          );
        }
        const ok = res.write(chunk);
        if (!ok) await new Promise((r) => res.once('drain', r));
      }

      // Integrity check: if what we actually streamed doesn't match the
      // expected remaining size, something went wrong mid-download — better
      // to end the connection abnormally (browser/frontend will see a
      // failed/incomplete download and can retry/resume) than silently hand
      // over a truncated or corrupt file.
      const expectedBytes = size ? size - startByte : undefined;
      if (expectedBytes !== undefined && bytesSent !== expectedBytes) {
        console.error(`Size mismatch for msg ${msgId}: expected ${expectedBytes} (from offset ${startByte}), got ${bytesSent}`);
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
      try {
        await local.client.disconnect();
      } catch {
        // best-effort disconnect — the session is being dropped regardless
      }
      localClients.delete(sessionId);
    }
    await store.delete(sessionId);
    res.json({ status: 'ok' });
  });

  app.get('/', (_req, res) => res.send('TeleGrab MTProto backend is running.'));

  return app;
}

module.exports = { createApp, connectWithRetry, VALID_AUTH_FIELDS };
