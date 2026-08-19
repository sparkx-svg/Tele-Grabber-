import { dom } from './dom.js';
import { state } from './state.js';
import { log, loadTheme, initThemeToggle, initSettingsToggle } from './ui.js';
import { pickFolder, resetFolder, restoreFolderDisplay } from './storage.js';
import { isValidCdnUrl, suggestCdnUrls } from './cdnResolver.js';
import { downloadTelegramFile, grabAny } from './download.js';
import { initAuth } from './auth.js';

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
dom.grabBtn.addEventListener('click', () => {
    const input = dom.fileUrlInput.value.trim();
    if (!input) {
        log('⚠️ Please paste a URL first.', 'warn');
        return;
    }
    grabAny(input);
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
    for (const line of lines) {
        if (state.isDownloading) {
            await new Promise((resolve) => {
                const check = () => {
                    if (!state.isDownloading) resolve();
                    else setTimeout(check, 300);
                };
                check();
            });
        }
        await grabAny(line);
    }
    log('✅ Bulk grab finished.', 'done');
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
    const text = await file.text();
    dom.bulkUrls.value = text;
    log(`📁 Loaded ${text.split('\n').filter(Boolean).length} URL(s) from ${file.name}`, 'info');
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
