import { dom } from './dom.js';
import { state } from './state.js';
import { log, renderProgress, resetProgressUI, finishProgressUI, hashAndDisplay, getFileType } from './ui.js';
import { saveFileWithFolder } from './storage.js';
import { isValidCdnUrl, resolveTelegramLink } from './cdnResolver.js';
import { mtBackend } from './auth.js';

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

// ===== Stream any fetch Response into the shared progress/hash/save pipeline =====
export async function streamResponseToFile(response, fileName) {
    const contentLength = response.headers.get('content-length');
    state.totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
    if (state.totalBytes > 0) log(`📊 File size: ${(state.totalBytes / 1024 / 1024).toFixed(1)} MB`, 'info');

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    state.startTime = performance.now();

    while (true) {
        if (state.cancelDownload) {
            await reader.cancel();
            throw new Error('Download cancelled');
        }
        if (state.paused) await waitWhilePaused();

        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        state.receivedBytes = received;

        const elapsed = (performance.now() - state.startTime) / 1000;
        renderProgress(received, state.totalBytes, elapsed);
    }

    const blob = new Blob(chunks);
    await saveFileWithFolder(blob, fileName);
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

        try {
            const response = await fetch(cdnUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            });
            if (response.ok) {
                await streamResponseToFile(response, state.currentFileName);
                return;
            }
        } catch (err) {
            log(`⚠️ Direct download failed: ${err.message}`, 'warn');
        }

        log('🔄 Trying proxy download...', 'resolving');
        const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(cdnUrl)}`;
        const response = await fetch(proxyUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} - ${response.statusText}`);
        await streamResponseToFile(response, state.currentFileName);
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
        const response = await fetch(url);
        if (!response.ok) {
            let msg = `HTTP ${response.status}`;
            try {
                const j = await response.json();
                if (j.error) msg = j.error;
            } catch {
                // response body wasn't JSON; keep the HTTP status message
            }
            throw new Error(msg);
        }
        const disposition = response.headers.get('content-disposition') || '';
        const match = disposition.match(/filename="?([^"]+)"?/);
        const fileName = match ? decodeURIComponent(match[1]) : (link.split('/').pop() || 'telegram_file.bin');
        await streamResponseToFile(response, fileName);
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
// custom progress bar, no SHA256 hash, no pause/resume.
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
}
