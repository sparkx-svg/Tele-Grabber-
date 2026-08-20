// ===== Shared frontend constants =====
// Centralizes magic numbers that previously appeared inline (and sometimes
// inconsistently) across download.js, cdnResolver.js, storage.js, ui.js.

// ---- Byte-size math --------------------------------------------------
export const BYTES_PER_KB = 1024;
export const BYTES_PER_MB = BYTES_PER_KB * 1024;

// ---- Networking / retries ---------------------------------------------
// How many times downloadResumable() will retry a dropped connection (or a
// retryable HTTP status) mid-download before giving up and surfacing the
// error to the user.
export const MAX_STREAM_RETRIES = 6;

// How many times a single CDN brute-force HEAD probe is retried before
// being counted as a failure. Deliberately small — this fires once per
// *guessed* URL, of which there can be hundreds, so a generous retry count
// here would make brute-forcing painfully slow.
export const CDN_PROBE_MAX_RETRIES = 2;

// How many URLs resolveTelegramLink() probes concurrently per batch when
// brute-forcing cdn.telegram.org filenames.
export const CDN_PROBE_BATCH_SIZE = 10;

// Log a progress update to the user every N brute-forced URLs.
export const CDN_PROBE_PROGRESS_LOG_INTERVAL = 50;

export const RETRY_BASE_DELAY_MS = 500;
export const RETRY_MAX_DELAY_MS = 15_000;
// Backoff range used specifically when a whole batch of CDN probes looks
// rate-limited (see cdnResolver.js) rather than per-request retries.
export const CDN_THROTTLE_BASE_DELAY_MS = 1_000;
export const CDN_THROTTLE_MAX_DELAY_MS = 20_000;

// ---- UI polling intervals ----------------------------------------------
export const PAUSE_POLL_INTERVAL_MS = 200;
export const BULK_QUEUE_POLL_INTERVAL_MS = 300;

// ---- Hashing ------------------------------------------------------------
// crypto.subtle.digest() needs the ENTIRE file loaded into one contiguous
// buffer at once. On mobile browsers this can silently fail, hang, or crash
// the tab for files in the several-hundred-MB+ range, so files above this
// limit skip hashing entirely rather than risk breaking the download itself.
export const HASH_SIZE_LIMIT_BYTES = 300 * BYTES_PER_MB;

// ---- Session encryption (storage.js) ------------------------------------
export const PBKDF2_ITERATIONS = 100_000;
export const AES_KEY_LENGTH_BITS = 256;
export const PBKDF2_SALT_LENGTH_BYTES = 16;
export const AES_GCM_IV_LENGTH_BYTES = 12;
export const MIN_PIN_LENGTH = 4;
