import { dom } from './dom.js';
import { state } from './state.js';
import { log, renderProgress, resetProgressUI, finishProgressUI, hashAndDisplay, getFileType } from './ui.js';
import { saveFileWithFolder } from './storage.js';
import { isValidCdnUrl, resolveTelegramLink } from './cdnResolver.js';
import { mtBackend } from './auth.js';
import { isRetryableStatus, isTransientNetworkError, backoffDelay, sleep } from './net.js';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const MAX_STREAM_RETRIES = 6; // network hiccups mid-download, not brute-force probes — worth persisting through

// ===== Wait out a pause loop =====
function waitWhilePaused() {
    return new Promise((resolve) => {
        const check = () => {
            if (!state.paused) resolve();
            else setTimeout(check, 200);
        };
        check();
    });
}

// ===== Read one response body into `chunks`, reporting progress as it goes =====
// Throws if the connection drops mid-stream (network error) or the user
// cancels — both are handled by the caller (downloadResumable), which
// decides whether to retry/resume or give up.
async function readStreamInto(response, chunks, onChunk) {
    const reader = response.body.getReader();
    try {
        while (true) {
            if (state.cancelDownload) {
                await reader.cancel();
                throw new Error('Download cancelled');
            }
            if (state.paused) await waitWhilePaused();

            const { done, value } = await reader.read();
            if (done) return;
            chunks.push(value);
            onChunk(value.length);
        }
    } finally {
        try { reader.releaseLock(); } catch {
            // response already errored/closed — nothing to release
        }
    }
}

/**
 * Core download engine: fetches via `requestFactory(offsetBytes)`, streams
 * the body into memory, and — if the connection drops or the server hiccups
 * partway through — retries with exponential backoff, re-requesting a
 * `Range: bytes=<received>-` continuation instead of starting over.
 *
 * `requestFactory` is responsible for attaching a Range header when called
 * with offset > 0. If the server doesn't honor Range (responds 200 instead
 * of 206), previously-buffered bytes are discarded and we treat that
 * response as a fresh full download rather than corrupting the file by
 * blindly appending.
 */
export async function downloadResumable({ requestFactory, fileName }) {
    const chunks = [];
    let received = 0;
    let totalBytes = 0;
    let attempt = 0;
    state.startTime = performance.now();
    state.receivedBytes = 0;
    state.totalBytes = 0;

    while (true) {
        if (state.cancelDownload) throw new Error('Download cancelled');
        if (state.paused) await waitWhilePaused();

        let response;
        try {
            response = await requestFactory(received);
        } catch (err) {
            if (err.message === 'Download cancelled' || err.name === 'AbortError') throw err;
            if (!isTransientNetworkError(err) || attempt >= MAX_STREAM_RETRIES) throw err;
            attempt += 1;
            const delay = backoffDelay(attempt);
            log(`⚠️ Connection error (${err.message}) — retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt}/${MAX_STREAM_RETRIES})...`, 'warn');
            await sleep(delay);
            continue;
        }

        if (!response.ok && response.status !== 206) {
            if (isRetryableStatus(response.status) && attempt < MAX_STREAM_RETRIES) {
                attempt += 1;
                const delay = backoffDelay(attempt);
                log(`⚠️ Server returned HTTP ${response.status} — retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt}/${MAX_STREAM_RETRIES})...`, 'warn');
                await sleep(delay);
                continue;
            }
            throw new Error(`HTTP ${response.status} - ${response.statusText}`);
        }

        // We asked for a Range continuation (received > 0) but got a full
        // 200 back instead of a 206 — this server doesn't support resuming.
        // Discard what we had and treat this response as a fresh download,
        // since re-appending it after existing bytes would corrupt the file.
        if (received > 0 && response.status !== 206) {
            log('⚠️ Server doesn\'t support resuming this download — restarting from the beginning.', 'warn');
            chunks.length = 0;
            received = 0;
            state.receivedBytes = 0;
        }

        if (received === 0) {
            const contentLength = response.headers.get('content-length');
            totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
            state.totalBytes = totalBytes;
            if (totalBytes > 0) log(`📊 File size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`, 'info');
        }

        try {
            await readStreamInto(response, chunks, (len) => {
                received += len;
                state.receivedBytes = received;
                const elapsed = (performance.now() - state.startTime) / 1000;
                renderProgress(received, totalBytes, elapsed);
            });
            break; // stream finished cleanly
        } catch (err) {
            if (err.message === 'Download cancelled') throw err;
            // Mid-stream errors are almost always the connection dropping —
            // retry up to the cap regardless of exact error type, then
            // surface it rather than looping forever.
            if (attempt >= MAX_STREAM_RETRIES) throw err;
            attempt += 1;
            const delay = backoffDelay(attempt);
            log(`⚠️ Connection dropped mid-download (${err.message}) — resuming from ${(received / 1024 / 1024).toFixed(1)} MB in ${(delay / 1000).toFixed(1)}s (attempt ${attempt}/${MAX_STREAM_RETRIES})...`, 'warn');
            await sleep(delay);
            // loop back — requestFactory(received) will issue a Range request
        }
    }

    // `fileName` can be a plain string (known upfront, e.g. the legacy CDN
    // path) or a function (e.g. the MTProto path, where it's only known once
    // the first response's Content-Disposition header arrives) — resolved
    // here, after the transfer finishes, so either form works.
    const resolvedFileName = typeof fileName === 'function' ? fileName() : fileName;
    const blob = new Blob(chunks);
    await saveFileWithFolder(blob, resolvedFileName);
    log(`✅ Complete: ${(blob.size / 1024 / 1024).toFixed(2)} MB`, 'done');
    await hashAndDisplay(blob);
    return blob;
}

// ===== Legacy path: t.me link -> guessed CDN URL -> direct fetch -> proxy fallback =====
export async function downloadTelegramFile(input) {
    if (!input) {
        log('⚠️ No URL provided.', 'warn');
        return;
    }
    if (state.isDownloading) {
        log('⚠️ Download already in progress.', 'warn');
        return;
    }

    state.isDownloading = true;
    resetProgressUI();

    try {
        let cdnUrl = input;

        if (input.includes('t.me/')) {
            const resolved = await resolveTelegramLink(input);
            if (resolved) {
                cdnUrl = resolved;
                log('✅ Successfully resolved to CDN URL', 'done');
            } else {
                log('❌ Could not resolve automatically.', 'error');
                log('💡 Please enter the CDN URL manually in the field above.', 'info');
                log('💡 Click "Suggest" for likely URLs.', 'info');
                dom.progressContainer.classList.add('hidden');
                return;
            }
        }

        if (!isValidCdnUrl(cdnUrl)) {
            log('❌ Invalid CDN URL.', 'error');
            return;
        }

        state.currentFileName = cdnUrl.split('/').pop() || 'telegram_file.bin';
        if (!state.currentFileName.includes('.')) state.currentFileName += '.bin';

        log(`📁 File: ${state.currentFileName}`, 'info');
        log(`📁 Type: ${getFileType(cdnUrl)}`, 'info');
        log('⬇️ Starting download...', 'info');

        // Probe once (no retry — this just decides direct-vs-proxy) so we
        // don't burn retries/backoff on a path we're about to abandon anyway.
        let useDirect = false;
        try {
            const probe = await fetch(cdnUrl, { method: 'HEAD', headers: { 'User-Agent': DEFAULT_UA } });
            useDirect = probe.ok;
        } catch {
            useDirect = false;
        }

        if (useDirect) {
            try {
                await downloadResumable({
                    fileName: state.currentFileName,
                    requestFactory: (offset) => {
                        const headers = { 'User-Agent': DEFAULT_UA };
                        if (offset > 0) headers.Range = `bytes=${offset}-`;
                        return fetch(cdnUrl, { headers });
                    },
                });
                return;
            } catch (err) {
                if (err.message === 'Download cancelled') throw err;
                log(`⚠️ Direct download failed after retries: ${err.message}`, 'warn');
            }
        }

        log('🔄 Trying proxy download...', 'resolving');
        const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(cdnUrl)}`;
        await downloadResumable({
            fileName: state.currentFileName,
            requestFactory: (offset) => {
                const headers = { 'User-Agent': DEFAULT_UA };
                // Best-effort: not all proxies forward Range headers upstream.
                // downloadResumable already falls back to a clean restart if
                // this proxy ignores it and returns 200 instead of 206.
                if (offset > 0) headers.Range = `bytes=${offset}-`;
                return fetch(proxyUrl, { headers });
            },
        });
    } catch (err) {
        if (err.message === 'Download cancelled') log('⚠️ Download cancelled by user.', 'warn');
        else log(`❌ Download failed: ${err.message}`, 'error');
    } finally {
        state.isDownloading = false;
        finishProgressUI();
    }
}

// ===== Real path: download via the MTProto backend (real user login, up to 2GB/4GB) =====
export async function downloadViaMTProto(link) {
    if (state.isDownloading) {
        log('⚠️ Download already in progress.', 'warn');
        return;
    }
    state.isDownloading = true;
    resetProgressUI();

    try {
        log(`⬇️ Requesting ${link} via MTProto…`, 'info');
        const url = `${mtBackend()}/download?sessionId=${encodeURIComponent(state.mtSessionId)}&link=${encodeURIComponent(link)}`;

        let fileName = null;
        let lastBackendError = null;

        await downloadResumable({
            fileName: () => fileName || (link.split('/').pop() || 'telegram_file.bin'),
            requestFactory: async (offset) => {
                const headers = {};
                if (offset > 0) headers.Range = `bytes=${offset}-`;
                const response = await fetch(url, { headers });

                if (!response.ok && response.status !== 206) {
                    // Pull the backend's JSON { error } out for a clearer
                    // message if we end up exhausting retries and throwing.
                    try {
                        const j = await response.clone().json();
                        if (j.error) lastBackendError = j.error;
                    } catch {
                        // response body wasn't JSON; downloadResumable will
                        // fall back to a generic "HTTP <status>" message
                    }
                    // Auth/not-found/etc. errors from our own backend aren't
                    // transient — don't waste retries on them.
                    if (response.status < 500 && response.status !== 408 && response.status !== 429) {
                        throw new Error(lastBackendError || `HTTP ${response.status}`);
                    }
                } else if (fileName === null) {
                    const disposition = response.headers.get('content-disposition') || '';
                    const match = disposition.match(/filename="?([^"]+)"?/);
                    fileName = match ? decodeURIComponent(match[1]) : (link.split('/').pop() || 'telegram_file.bin');
                }
                return response;
            },
        });
    } catch (err) {
        if (err.message === 'Download cancelled') log('⚠️ Download cancelled by user.', 'warn');
        else log(`❌ MTProto download failed: ${err.message}`, 'error');
    } finally {
        state.isDownloading = false;
        finishProgressUI();
    }
}

// ===== Native browser download (no JS memory buffering) =====
// Hands the URL to the browser's own downloader instead of fetch()-ing it
// into a growing array of chunks then wrapping it in one giant Blob (which
// for a 4GB file means holding all 4GB in the tab's RAM). Trade-off: no
// custom progress bar, no SHA256 hash, no pause/resume — but the browser's
// own downloader has its own retry/resume behavior for dropped connections.
export function triggerNativeDownload(url) {
    log('⬇️ Handed off to your browser\'s downloader — check its download tray for progress.', 'info');
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
}

// ===== Router: use MTProto when logged in, otherwise fall back to legacy CDN guessing =====
export async function grabAny(input) {
    try {
        if (state.mtLoggedIn && mtBackend() && input.includes('t.me/')) {
            if (dom.nativeDownloadToggle.checked) {
                const url = `${mtBackend()}/download?sessionId=${encodeURIComponent(state.mtSessionId)}&link=${encodeURIComponent(input)}`;
                triggerNativeDownload(url);
            } else {
                await downloadViaMTProto(input);
            }
        } else {
            await downloadTelegramFile(input);
        }
    } catch (err) {
        // Both downloadTelegramFile and downloadViaMTProto already catch and
        // log their own errors internally, so this is a last-resort net for
        // anything unexpected (e.g. a bug), keeping it from becoming an
        // unhandled promise rejection when callers don't await grabAny().
        log(`❌ Unexpected error: ${err.message}`, 'error');
    }
}
