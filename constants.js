// ===== Shared backend constants =====
// Centralizes magic numbers that previously appeared inline in server.js.

// ---- Byte-size math --------------------------------------------------
const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;

// ---- Request body limits -------------------------------------------------
// Auth payloads are tiny (phone/code/password strings), so this is generous
// headroom while still blocking someone trying to flood the process with an
// oversized request body.
const JSON_BODY_LIMIT = '10kb';

// ---- Rate limiting --------------------------------------------------------
// Login attempts are the sensitive surface here: each /auth/start triggers a
// real Telegram SendCode call, and each /auth/submit is a guessable-code
// attempt. Cap both per IP so the backend (and the Telegram account behind
// it) can't be hammered.
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const AUTH_RATE_LIMIT_MAX = 5; // attempts per IP per window

const DOWNLOAD_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const DOWNLOAD_RATE_LIMIT_MAX = 20; // generous — legitimate bulk-grab usage still fits

// ---- MTProto client behavior ----------------------------------------------
// GramJS's own internal reconnection attempts once a client is connected.
const CLIENT_CONNECTION_RETRIES = 5;

// Extra retry wrapper (see connectWithRetry in app.js) around the *initial*
// client.connect() call, which GramJS's connectionRetries option doesn't
// cover.
const CONNECT_RETRY_ATTEMPTS = 3;
const CONNECT_RETRY_BASE_DELAY_MS = 1000;

// How long to wait after kicking off client.start() / resolving a pending
// phone-code or password prompt before checking whether the in-memory
// session metadata has already settled (logged in / errored / needs more
// input). This is a pragmatic short poll delay, not a hard timeout — the
// frontend keeps polling /auth/status regardless.
const AUTH_SETTLE_DELAY_MS = 1500;

// ---- File download streaming -----------------------------------------
// Chunk size requested per iterDownload() call.
const DOWNLOAD_CHUNK_SIZE_BYTES = 1 * BYTES_PER_MB;

module.exports = {
  BYTES_PER_KB,
  BYTES_PER_MB,
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
};
