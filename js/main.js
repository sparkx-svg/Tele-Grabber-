import { dom } from './dom.js';
import { state } from './state.js';
import { log, loadTheme, initThemeToggle, initSettingsToggle } from './ui.js';
import { pickFolder, resetFolder, restoreFolderDisplay } from './storage.js';
import { isValidCdnUrl, suggestCdnUrls } from './cdnResolver.js';
import { downloadTelegramFile, grabAny } from './download.js';
import { initAuth } from './auth.js';
import { BULK_QUEUE_POLL_INTERVAL_MS } from './constants.js';

// ===== Global safety net =====
// Every async call site in this app is meant to catch its own errors, but
// this is a last-resort backstop: without it, any promise rejection that
// slips through (a future bug, a browser API behaving unexpectedly) fails
// silently in the console with zero user-facing feedback instead of
// crashing the tab. It doesn't fix the underlying issue, just makes sure
// the user finds out via the status log instead of a stuck-forever UI.
window.addEventListener('unhandledrejection', (event) => {
    log(`❌ Unexpected error: ${event.reason?.message || event.reason}`, 'error');
    event.preventDefault();
});

// ===== Theme + settings panel =====
loadTheme();
initThemeToggle();
initSettingsToggle();

// ===== Folder picker =====
restoreFolderDisplay();
dom.pickFolderBtn.addEventListener('click', pickFolder);
dom.resetFolderBtn.addEventListener('click', resetFolder);

// ===== Manual CDN fallback field =====
const manualCdnInput = document.getElementById('manualCdnInput');
const useManualBtn = document.getElementById('useManualBtn');
const suggestCdnBtn = document.getElementById('suggestCdnBtn');

useManualBtn.addEventListener('click', () => {
    const url = manualCdnInput.value.trim();
    if (isValidCdnUrl(url)) {
        log(`✅ Manual CDN set: ${url}`, 'done');
        downloadTelegramFile(url);
    } else {
        log('❌ Invalid CDN URL. Must look like https://cdn.telegram.org/file/name.ext with a recognized extension.', 'error');
    }
});

suggestCdnBtn.addEventListener('click', () => {
    const input = dom.fileUrlInput.value.trim();
    const suggestions = suggestCdnUrls(input);
    if (suggestions.length) {
        manualCdnInput.value = suggestions[0];
        log(`💡 Suggested: ${suggestions[0]}`, 'info');
        log(`💡 Also try: ${suggestions.slice(1).join(', ')}`, 'info');
    }
});

// ===== Native download preference =====
const savedNativePref = localStorage.getItem('telegrab-native-download');
if (savedNativePref !== null) dom.nativeDownloadToggle.checked = savedNativePref === 'true';
dom.nativeDownloadToggle.addEventListener('change', () => {
    localStorage.setItem('telegrab-native-download', dom.nativeDownloadToggle.checked);
});

// ===== Main grab controls =====
// Browser event listeners don't propagate rejected promises anywhere useful
// — an unhandled rejection here would just get silently logged to the
// console with no user-facing feedback. grabAny() already catches its own
// errors internally, but this .catch is a defensive backstop in case that
// ever changes.
dom.grabBtn.addEventListener('click', () => {
    const input = dom.fileUrlInput.value.trim();
    if (!input) {
        log('⚠️ Please paste a URL first.', 'warn');
        return;
    }
    grabAny(input).catch((err) => log(`❌ Unexpected error: ${err.message}`, 'error'));
});

dom.fileUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dom.grabBtn.click();
});

dom.bulkGrabBtn.addEventListener('click', async () => {
    const lines = dom.bulkUrls.value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) {
        log('⚠️ Please paste at least one URL.', 'warn');
        return;
    }
    log(`📥 Starting bulk grab of ${lines.length} URL(s)...`, 'info');
    try {
        for (const line of lines) {
            if (state.isDownloading) {
                await new Promise((resolve) => {
                    const check = () => {
                        if (!state.isDownloading) resolve();
                        else setTimeout(check, BULK_QUEUE_POLL_INTERVAL_MS);
                    };
                    check();
                });
            }
            // grabAny() already catches its own errors and logs them, so one
            // bad URL in the batch won't throw here and abort the rest —
            // but this listener is async and unawaited by the browser, so a
            // truly unexpected error still needs a local catch to avoid an
            // unhandled rejection.
            await grabAny(line);
        }
        log('✅ Bulk grab finished.', 'done');
    } catch (err) {
        log(`❌ Bulk grab stopped early: ${err.message}`, 'error');
    }
});

// ===== Drag & drop a .txt file of URLs =====
dom.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dom.dropZone.classList.add('drag-over');
});
dom.dropZone.addEventListener('dragleave', () => {
    dom.dropZone.classList.remove('drag-over');
});
dom.dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dom.dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (!file || !file.name.endsWith('.txt')) {
        log('⚠️ Please drop a .txt file with URLs.', 'warn');
        return;
    }
    try {
        const text = await file.text();
        dom.bulkUrls.value = text;
        log(`📁 Loaded ${text.split('\n').filter(Boolean).length} URL(s) from ${file.name}`, 'info');
    } catch (err) {
        log(`⚠️ Could not read dropped file: ${err.message}`, 'warn');
    }
});

// ===== Hash copy =====
dom.copyHashBtn.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(dom.hashValue.textContent);
        log('📋 Hash copied to clipboard.', 'done');
    } catch (err) {
        log(`⚠️ Copy failed: ${err.message}`, 'warn');
    }
});

// ===== Pause / resume =====
dom.pauseBtn.addEventListener('click', () => {
    state.paused = true;
    dom.pauseBtn.classList.add('hidden');
    dom.resumeBtn.classList.remove('hidden');
    log('⏸ Paused.', 'warn');
});

dom.resumeBtn.addEventListener('click', () => {
    state.paused = false;
    dom.resumeBtn.classList.add('hidden');
    dom.pauseBtn.classList.remove('hidden');
    log('▶ Resumed.', 'info');
});

// ===== MTProto auth panel =====
initAuth();
