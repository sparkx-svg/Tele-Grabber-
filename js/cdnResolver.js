// ===== Legacy CDN URL guessing (fallback only) =====
// cdn.telegram.org links are per-download, signed, and expire — they can't
// really be brute-forced (see README). This survives only as a last-resort
// fallback for people who haven't set up the MTProto backend; the real,
// reliable path is auth.js + download.js's downloadViaMTProto().
//
// The pure URL-construction/validation logic lives in cdnUrlUtils.js (unit
// tested in tests/cdnUrlUtils.test.mjs); this module wires that logic up to
// the actual network probing, UI logging, and cancellation state.
import { state } from './state.js';
import { log, getFileType } from './ui.js';
import { fetchWithRetry, backoffDelay, sleep } from './net.js';
import { isValidCdnUrl, suggestCdnUrls, buildCdnGuessUrls } from './cdnUrlUtils.js';
import {
    CDN_PROBE_MAX_RETRIES,
    CDN_PROBE_BATCH_SIZE,
    CDN_PROBE_PROGRESS_LOG_INTERVAL,
    CDN_THROTTLE_BASE_DELAY_MS,
    CDN_THROTTLE_MAX_DELAY_MS,
    BYTES_PER_MB,
} from './constants.js';

export { isValidCdnUrl, suggestCdnUrls };

// ===== Main resolver: t.me link -> best-guess CDN URL (unreliable) =====
export async function resolveTelegramLink(link) {
    log(`🔄 Resolving: ${link}`, 'resolving');

    if (link.startsWith('https://cdn.telegram.org/file/')) {
        return link;
    }

    const possibleUrls = buildCdnGuessUrls(link);
    log(`🔄 Generated ${possibleUrls.length} possible URLs to try...`, 'resolving');

    // Tracks consecutive batches that hit a transient error (429/5xx/network)
    // on every URL in the batch — a strong signal the CDN is rate-limiting
    // us, not that all CDN_PROBE_BATCH_SIZE guesses happened to be wrong.
    // Escalating backoff between batches in that case (on top of
    // fetchWithRetry's per-request backoff) keeps us from hammering a host
    // that's already telling us to slow down.
    let consecutiveThrottledBatches = 0;

    for (let i = 0; i < possibleUrls.length; i += CDN_PROBE_BATCH_SIZE) {
        if (state.cancelDownload) break;

        const batch = possibleUrls.slice(i, i + CDN_PROBE_BATCH_SIZE);
        let batchAllTransientFailures = true;

        const results = await Promise.all(batch.map(async (url) => {
            try {
                const test = await fetchWithRetry(url, {
                    method: 'HEAD',
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                }, {
                    maxRetries: CDN_PROBE_MAX_RETRIES, // this is a brute-force probe, not a real download — keep it cheap
                    shouldAbort: () => state.cancelDownload,
                });
                if (test.ok) {
                    batchAllTransientFailures = false;
                    const contentLength = test.headers.get('content-length') || 'unknown';
                    const sizeMB = contentLength !== 'unknown' ? (parseInt(contentLength, 10) / BYTES_PER_MB).toFixed(1) : '?';
                    log(`✅ Found working URL: ${url}`, 'done');
                    log(`📁 Type: ${getFileType(url)}, Size: ${sizeMB} MB`, 'info');
                    return url;
                }
                // A clean non-ok, non-retried response (e.g. 404) means this
                // guess was just wrong — not a sign of throttling.
                batchAllTransientFailures = false;
            } catch {
                // Ran out of retries on a transient error (network/429/5xx)
                // — leave batchAllTransientFailures as-is for this URL.
            }
            return null;
        }));

        const found = results.find((r) => r !== null);
        if (found) return found;

        if (batchAllTransientFailures) {
            consecutiveThrottledBatches += 1;
            const delay = backoffDelay(consecutiveThrottledBatches, CDN_THROTTLE_BASE_DELAY_MS, CDN_THROTTLE_MAX_DELAY_MS);
            log(`⚠️ CDN looks rate-limited — backing off ${(delay / 1000).toFixed(1)}s before continuing...`, 'warn');
            await sleep(delay);
        } else {
            consecutiveThrottledBatches = 0;
        }

        if (i % CDN_PROBE_PROGRESS_LOG_INTERVAL === 0 && i > 0) {
            log(`🔄 Tried ${i}/${possibleUrls.length} URLs...`, 'resolving');
        }
    }

    try {
        log('🔄 Trying direct page extraction...', 'resolving');
        const response = await fetchWithRetry(link, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Accept: 'text/html',
            },
        }, { maxRetries: 3, shouldAbort: () => state.cancelDownload });
        if (response.ok) {
            const html = await response.text();
            const cdnMatches = html.match(/https:\/\/cdn\.telegram\.org\/file\/[^\s"']+/g) || [];
            for (const url of cdnMatches) {
                try {
                    const test = await fetchWithRetry(url, { method: 'HEAD' }, {
                        maxRetries: CDN_PROBE_MAX_RETRIES,
                        shouldAbort: () => state.cancelDownload,
                    });
                    if (test.ok) {
                        log(`✅ Found via page extraction: ${url}`, 'done');
                        log(`📁 Type: ${getFileType(url)}`, 'info');
                        return url;
                    }
                } catch {
                    // try next match
                }
            }
        }
    } catch (err) {
        log(`⚠️ Direct parse failed: ${err.message}`, 'warn');
    }

    log('❌ All resolution methods failed.', 'error');
    log('💡 Use the manual CDN field above or click "Suggest" for ideas.', 'info');
    return null;
}
