// ===== Shared fetch retry / backoff helper =====
// Centralizes "how many times do we retry a flaky request, and how long do
// we wait between attempts" so cdnResolver's brute-force probing and
// download.js's file transfers don't each reinvent (and potentially
// mis-tune) their own retry logic.

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 15000;

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Full-jitter exponential backoff: base * 2^attempt, capped, then
// randomized down. The jitter matters here specifically because bulk-grab
// mode can have many "requests" backing off at once (batches of CDN probes,
// or several queued downloads) — without jitter they'd all wake up and
// retry in lockstep, re-creating the exact burst that likely got them
// rate-limited in the first place.
export function backoffDelay(attempt, baseMs = DEFAULT_BASE_DELAY_MS, maxMs = DEFAULT_MAX_DELAY_MS) {
    const exp = Math.min(maxMs, baseMs * 2 ** attempt);
    return Math.random() * exp;
}

// Should this HTTP status be retried, or is it a "real" final answer?
// 404 while brute-forcing a filename isn't a transient failure — it just
// means that guess was wrong — so it must NOT be retried or brute-forcing
// would take forever. 408/429/5xx are worth another attempt.
export function isRetryableStatus(status) {
    return status === 408 || status === 429 || status >= 500;
}

// fetch() rejects (rather than resolving with a bad status) for DNS
// failures, dropped connections, CORS blocks, being offline, etc. — all
// worth retrying. A deliberate AbortError (user cancelled) is not.
export function isTransientNetworkError(err) {
    return err instanceof TypeError && err.name !== 'AbortError';
}

/**
 * fetch() wrapped with retry + exponential backoff.
 * - Retries on network errors and 408/429/5xx responses.
 * - Does NOT retry on other 4xx — those mean "this request is wrong", not
 *   "try again".
 * - Checks `shouldAbort()` before every attempt (including the first) so
 *   retries stop immediately if the user cancels or pauses-then-cancels.
 */
export async function fetchWithRetry(url, options = {}, {
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    shouldAbort = () => false,
    onRetry = null, // (attemptNumber, delayMs, reason) => void
} = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (shouldAbort()) throw new Error('Download cancelled');
        try {
            const response = await fetch(url, options);
            if (response.ok || !isRetryableStatus(response.status) || attempt === maxRetries) {
                return response;
            }
            lastErr = new Error(`HTTP ${response.status} - ${response.statusText}`);
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            if (!isTransientNetworkError(err) || attempt === maxRetries) throw err;
            lastErr = err;
        }
        const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
        if (onRetry) onRetry(attempt + 1, delay, lastErr);
        await sleep(delay);
    }
    // Unreachable in practice (loop always returns or throws above), but
    // keeps this function's return type honest if maxRetries < 0.
    throw lastErr || new Error('Request failed with no further detail.');
}
