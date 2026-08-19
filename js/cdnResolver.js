// ===== Legacy CDN URL guessing (fallback only) =====
// cdn.telegram.org links are per-download, signed, and expire — they can't
// really be brute-forced (see README). This survives only as a last-resort
// fallback for people who haven't set up the MTProto backend; the real,
// reliable path is auth.js + download.js's downloadViaMTProto().
import { state } from './state.js';
import { log, getFileType, ALLOWED_EXTENSIONS } from './ui.js';
import { fetchWithRetry, backoffDelay, sleep } from './net.js';

const ALLOWED_CDN_HOST = 'cdn.telegram.org';

// Strict CDN URL validation: exact hostname match, locked-down path shape,
// extension allow-list. (The old check — startsWith('https://') && includes
// ('telegram.org') — is trivially spoofed, e.g. by
// "https://telegram.org.evil.com/x".)
export function isValidCdnUrl(input) {
    let parsed;
    try {
        parsed = new URL(input);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname !== ALLOWED_CDN_HOST) return false;
    const match = parsed.pathname.match(/^\/file\/([A-Za-z0-9._-]+)$/);
    if (!match) return false;
    const filename = match[1];
    if (filename.includes('..')) return false;
    const ext = filename.split('.').pop().toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) return false;
    return true;
}

export function suggestCdnUrls(input) {
    const match = input.match(/t\.me\/([^/]+)\/(\d+)/);
    if (!match) return [];
    const [, username, postId] = match;
    return [
        `https://cdn.telegram.org/file/${username}_${postId}_1.zip`,
        `https://cdn.telegram.org/file/${username}_${postId}.zip`,
        `https://cdn.telegram.org/file/${username}_${postId}_1.rar`,
        `https://cdn.telegram.org/file/${username}_${postId}_1.7z`,
        `https://cdn.telegram.org/file/${username}_${postId}_1.pdf`,
        `https://cdn.telegram.org/file/${username}_${postId}_1.mp4`,
    ];
}

function constructCdnUrls(link) {
    const match = link.match(/t\.me\/([^/]+)\/(\d+)/);
    if (!match) return [];
    const [, username, postId] = match;

    const extensions = [
        '.zip', '.rar', '.7z', '.gz', '.bz2', '.xz', '.tar',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
        '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm',
        '.mp3', '.wav', '.flac', '.aac', '.ogg',
        '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg',
        '.exe', '.msi', '.apk', '.dmg', '.pkg',
        '.iso', '.img', '.bin',
        '.txt', '.log', '.csv', '.json', '.xml', '.yml', '.yaml',
        '',
    ];

    const patterns = [
        `${username}_${postId}_1`, `${username}_${postId}_2`, `${username}_${postId}_3`,
        `${username}_${postId}_4`, `${username}_${postId}_5`, `${username}_${postId}`,
        `${username}_${postId}_file`, `${username}_${postId}_media`, `file_${postId}`,
        `${postId}_${username}`, `${username}_${postId}_download`,
        `${username}_${postId}_archive`, `${username}_${postId}_data`,
    ];

    const urls = [];
    for (const pattern of patterns) {
        for (const ext of extensions) {
            urls.push(`https://cdn.telegram.org/file/${pattern}${ext}`);
        }
    }
    return [...new Set(urls)];
}

// ===== Main resolver: t.me link -> best-guess CDN URL (unreliable) =====
export async function resolveTelegramLink(link) {
    log(`🔄 Resolving: ${link}`, 'resolving');

    if (link.startsWith('https://cdn.telegram.org/file/')) {
        return link;
    }

    const possibleUrls = constructCdnUrls(link);
    log(`🔄 Generated ${possibleUrls.length} possible URLs to try...`, 'resolving');

    const batchSize = 10;
    // Tracks consecutive batches that hit a transient error (429/5xx/network)
    // on every URL in the batch — a strong signal the CDN is rate-limiting
    // us, not that all 10 guesses happened to be wrong. Escalating backoff
    // between batches in that case (on top of fetchWithRetry's per-request
    // backoff) keeps us from hammering a host that's already telling us to
    // slow down.
    let consecutiveThrottledBatches = 0;

    for (let i = 0; i < possibleUrls.length; i += batchSize) {
        if (state.cancelDownload) break;

        const batch = possibleUrls.slice(i, i + batchSize);
        let batchAllTransientFailures = true;

        const results = await Promise.all(batch.map(async (url) => {
            try {
                const test = await fetchWithRetry(url, {
                    method: 'HEAD',
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                }, {
                    maxRetries: 2, // this is a brute-force probe, not a real download — keep it cheap
                    shouldAbort: () => state.cancelDownload,
                });
                if (test.ok) {
                    batchAllTransientFailures = false;
                    const contentLength = test.headers.get('content-length') || 'unknown';
                    const sizeMB = contentLength !== 'unknown' ? (parseInt(contentLength) / 1024 / 1024).toFixed(1) : '?';
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
            const delay = backoffDelay(consecutiveThrottledBatches, 1000, 20000);
            log(`⚠️ CDN looks rate-limited — backing off ${(delay / 1000).toFixed(1)}s before continuing...`, 'warn');
            await sleep(delay);
        } else {
            consecutiveThrottledBatches = 0;
        }

        if (i % 50 === 0 && i > 0) {
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
                        maxRetries: 2,
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
