import { dom } from './dom.js';
import { state } from './state.js';
import { log, renderProgress, resetProgressUI, finishProgressUI, hashAndDisplay, getFileType } from './ui.js';
import { saveFileWithFolder } from './storage.js';
import { isValidCdnUrl, resolveTelegramLink } from './cdnResolver.js';
import { mtBackend, attemptSessionResume } from './auth.js';
import { isRetryableStatus, isTransientNetworkError, backoffDelay, sleep } from './net.js';
import { MAX_STREAM_RETRIES, BYTES_PER_MB, PAUSE_POLL_INTERVAL_MS, LARGE_FILE_WARNING_BYTES } from './constants.js';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const MS_PER_SECOND = 1000;

// ===== Wait out a pause loop =====
function waitWhilePaused() {
    return new Promise((resolve) => {
        const check = () => {
            if (!state.paused) resolve();
            else setTimeout(check, PAUSE_POLL_INTERVAL_MS);
        };
        check();
    });
}

// ===== Read one response body, writing chunks via `writeChunk`, reporting progress as it goes =====
// Throws if the connection drops mid-stream (network error) or the user
// cancels — both are handled by the caller (downloadResumable), which
// decides whether to retry/resume or give up.
async function readStreamInto(response, writeChunk, onChunk) {
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
            await writeChunk(value);
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
 * the body to disk (or, if no save folder is selected, into memory), and —
 * if the connection drops or the server hiccups partway through — retries
 * with exponential backoff, re-requesting a `Range: bytes=<received>-`
 * continuation instead of starting over.
 *
 * Writing straight to disk via the File System Access API (when
 * `state.selectedFolderHandle` is set) matters for two reasons: it keeps
 * memory use roughly constant regardless of file size (buffering a 4GB file
 * as an in-memory array of chunks is exactly the kind of thing that makes a
 * mobile browser tab crash), and — critically — it means that if a download
 * ultimately fails after exhausting retries, whatever was already
 * downloaded is committed to a real (if incomplete) file on disk instead of
 * being silently discarded along with the in-memory buffer that held it.
 * Without a folder selected, there's no way around buffering in memory —
 * the browser's plain download-a-Blob mechanism needs the whole thing at
 * once — so that path is kept as a fallback, with a warning for large files.
 *
 * `requestFactory` is responsible for attaching a Range header when called
 * with offset > 0. If the server doesn't honor Range (responds 200 instead
 * of 206), previously-written/buffered bytes are discarded and we treat
 * that response as a fresh full download rather than corrupting the file by
 * blindly appending.
 */
export async function downloadResumable({ requestFactory, fileName }) {
    let received = 0;
    let totalBytes = 0;
    let attempt = 0;
    state.startTime = performance.now();
    state.receivedBytes = 0;
    state.totalBytes = 0;

    let resolvedFileName = typeof fileName === 'string' ? fileName : null;
    let writable = null;      // open FileSystemWritableFileStream, when a save folder is selected
    const chunks = [];        // in-memory fallback, used only when no folder is selected (or opening the file failed)

    // Discards whatever's been written/buffered so far and, if a save
    // folder is selected, opens a fresh (truncating) writable for
    // `resolvedFileName`. Used both for the very first write and for a
    // forced restart-from-scratch (server doesn't support Range resume).
    async function resetSink() {
        if (writable) {
            try { await writable.abort(); } catch { /* best-effort — we're discarding this attempt anyway */ }
            writable = null;
        }
        chunks.length = 0;
        if (state.selectedFolderHandle && resolvedFileName) {
            try {
                const fileHandle = await state.selectedFolderHandle.getFileHandle(resolvedFileName, { create: true });
                writable = await fileHandle.createWritable();
            } catch (err) {
                log(`⚠️ Could not open "${resolvedFileName}" for incremental writing (${err.message}) — buffering in memory instead.`, 'warn');
                writable = null;
            }
        }
    }

    async function writeChunk(value) {
        if (writable) await writable.write(value);
        else chunks.push(value);
    }

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
            log(`⚠️ Connection error (${err.message}) — retrying in ${(delay / MS_PER_SECOND).toFixed(1)}s (attempt ${attempt}/${MAX_STREAM_RETRIES})...`, 'warn');
            await sleep(delay);
            continue;
        }

        if (!response.ok && response.status !== 206) {
            if (isRetryableStatus(response.status) && attempt < MAX_STREAM_RETRIES) {
                attempt += 1;
                const delay = backoffDelay(attempt);
                log(`⚠️ Server returned HTTP ${response.status} — retrying in ${(delay / MS_PER_SECOND).toFixed(1)}s (attempt ${attempt}/${MAX_STREAM_RETRIES})...`, 'warn');
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
            received = 0;
            state.receivedBytes = 0;
            await resetSink();
        }

        if (received === 0) {
            const contentLength = response.headers.get('content-length');
            totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
            state.totalBytes = totalBytes;
            if (totalBytes > 0) {
                log(`📊 File size: ${(totalBytes / BYTES_PER_MB).toFixed(1)} MB`, 'info');
                if (totalBytes > LARGE_FILE_WARNING_BYTES && !state.selectedFolderHandle) {
                    log(`⚠️ Large file and no save folder selected — it'll be held entirely in this tab's memory until it finishes, and if the download ultimately fails, that progress can't be recovered. Pick a save folder (📁) to write straight to disk instead.`, 'warn');
                }
            }

            // `fileName` can be a plain string (known upfront, e.g. the
            // legacy CDN path) or a function (e.g. the MTProto path, where
            // it's only known once the first response's Content-Disposition
            // header arrives) — resolved here, now that headers are in.
            if (resolvedFileName === null) resolvedFileName = typeof fileName === 'function' ? fileName() : fileName;
            if (!writable) await resetSink(); // first time through — opens the file now that we know its name
        }

        try {
            await readStreamInto(response, writeChunk, (len) => {
                received += len;
                state.receivedBytes = received;
                const elapsed = (performance.now() - state.startTime) / MS_PER_SECOND;
                renderProgress(received, totalBytes, elapsed);
            });
            break; // stream finished cleanly
        } catch (err) {
            if (err.message === 'Download cancelled') {
                // The user explicitly stopped it, but whatever did download
                // is still theirs — commit it rather than discarding it.
                if (writable) { try { await writable.close(); } catch { /* best-effort */ } }
                throw err;
            }
            if (attempt >= MAX_STREAM_RETRIES) {
                if (writable) {
                    try {
                        await writable.close();
                        const totalLabel = totalBytes ? `${(totalBytes / BYTES_PER_MB).toFixed(1)} MB` : 'unknown size';
                        log(`💾 Kept ${(received / BYTES_PER_MB).toFixed(1)} MB of ${totalLabel} as a partial file: "${resolvedFileName}". Re-running the download will overwrite it and start over.`, 'warn');
                    } catch (closeErr) {
                        log(`⚠️ Could not save the partial download: ${closeErr.message}`, 'warn');
                    }
                }
                throw err;
            }
            // Mid-stream errors are almost always the connection dropping —
            // retry up to the cap regardless of exact error type, then
            // surface it rather than looping forever.
            attempt += 1;
            const delay = backoffDelay(attempt);
            log(`⚠️ Connection dropped mid-download (${err.message}) — resuming from ${(received / BYTES_PER_MB).toFixed(1)} MB in ${(delay / MS_PER_SECOND).toFixed(1)}s (attempt ${attempt}/${MAX_STREAM_RETRIES})...`, 'warn');
            await sleep(delay);
            // loop back — requestFactory(received) will issue a Range request
        }
    }

    if (writable) {
        await writable.close();
        log(`✅ Complete: ${(received / BYTES_PER_MB).toFixed(2)} MB saved to "${resolvedFileName}"`, 'done');
        // Read back a File (Blob subclass) view of what we just wrote, for
        // hashing — this doesn't duplicate anything in memory, since we
        // never buffered the file's bytes as a JS array in the first place.
        try {
            const fileHandle = await state.selectedFolderHandle.getFileHandle(resolvedFileName);
            const file = await fileHandle.getFile();
            await hashAndDisplay(file);
            return file;
        } catch (err) {
            log(`ℹ️ Skipping hash (could not reopen the saved file: ${err.message}).`, 'info');
            return null;
        }
    }

    const blob = new Blob(chunks);
    await saveFileWithFolder(blob, resolvedFileName);
    log(`✅ Complete: ${(blob.size / BYTES_PER_MB).toFixed(2)} MB`, 'done');
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
        const buildUrl = () => `${mtBackend()}/download?sessionId=${encodeURIComponent(state.mtSessionId)}&link=${encodeURIComponent(link)}`;

        let fileName = null;
        let lastBackendError = null;
        // Guards against looping forever if a resume "succeeds" but the
        // backend still can't serve the file for some other reason — we only
        // ever attempt one recovery per 409, then let the normal retry/error
        // path take over. Reset after a successful resume so a *second*
        // mid-download restart (rare, but possible on a very large/slow
        // transfer) can also be recovered from.
        let sessionRecoveryInFlight = false;

        await downloadResumable({
            fileName: () => fileName || (link.split('/').pop() || 'telegram_file.bin'),
            requestFactory: async (offset) => {
                const headers = {};
                if (offset > 0) headers.Range = `bytes=${offset}-`;
                let response = await fetch(buildUrl(), { headers });

                // The backend lost track of our live TelegramClient — most
                // likely it restarted/redeployed mid-transfer, or (behind a
                // load balancer) this request landed on a different instance
                // than the one that logged us in. This is a real failure mode
                // on any download long enough to matter (multi-GB files can
                // take many minutes), and previously meant losing everything
                // downloaded so far. Recover automatically via the same saved
                // session string used to restore a login on page load,
                // instead of surfacing this as a fatal "please log in again".
                if (response.status === 409 && !sessionRecoveryInFlight) {
                    sessionRecoveryInFlight = true;
                    log('⚠️ Backend lost track of the login session mid-download — resuming automatically…', 'warn');
                    const resumed = await attemptSessionResume({ silent: true });
                    if (resumed) {
                        log('✅ Session resumed — continuing download from where it left off.', 'done');
                        sessionRecoveryInFlight = false;
                        response = await fetch(buildUrl(), { headers });
                    } else {
                        throw new Error(
                            'The login session was lost mid-download and couldn\'t be resumed automatically — please log in again. ' +
                            (state.selectedFolderHandle
                                ? 'What downloaded so far has been kept as a partial file in your chosen folder.'
                                : 'Without a save folder selected, progress so far could not be kept — pick a save folder before retrying large downloads.')
                        );
                    }
                }

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
