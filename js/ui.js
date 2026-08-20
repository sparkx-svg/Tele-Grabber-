import { dom } from './dom.js';
import { state } from './state.js';
import { HASH_SIZE_LIMIT_BYTES, BYTES_PER_MB } from './constants.js';
import { getFileType, ALLOWED_EXTENSIONS, FILE_TYPES } from './fileTypes.js';

// Re-exported for backward compatibility — other modules (download.js,
// cdnResolver.js) import these from here as well as from fileTypes.js
// directly. The actual definitions live in fileTypes.js, which has no DOM
// dependency and is unit-tested in isolation.
export { getFileType, ALLOWED_EXTENSIONS, FILE_TYPES };

// ===== Logging =====
export function log(msg, type = 'info') {
    const prefix = type === 'error' ? '❌' : type === 'done' ? '✅' : type === 'warn' ? '⚠️' : type === 'resolving' ? '🔄' : 'ℹ️';
    dom.statusLog.innerHTML += `\n${prefix} ${msg}`;
    dom.statusLog.scrollTop = dom.statusLog.scrollHeight;
    console.log(`[TeleGrab] ${msg}`);
}

// ===== Theme persistence =====
export function loadTheme() {
    const saved = localStorage.getItem('telegrab-theme');
    if (saved === 'light') {
        document.body.classList.add('light');
        dom.themeToggle.textContent = '☀️';
    } else {
        dom.themeToggle.textContent = '🌙';
    }
}

export function initThemeToggle() {
    dom.themeToggle.addEventListener('click', () => {
        const isLight = document.body.classList.toggle('light');
        dom.themeToggle.textContent = isLight ? '☀️' : '🌙';
        localStorage.setItem('telegrab-theme', isLight ? 'light' : 'dark');
    });
}

// ===== Settings toggle =====
export function initSettingsToggle() {
    dom.settingsToggle.addEventListener('click', () => {
        dom.settingsPanel.classList.toggle('hidden');
    });
}

// ===== File type detection =====
// Moved to fileTypes.js (pure, no DOM dependency) and re-exported above.

// ===== Progress bar rendering =====
export function renderProgress(received, total, elapsedSeconds) {
    const pct = total ? ((received / total) * 100).toFixed(1) : '?';
    const receivedMB = (received / BYTES_PER_MB).toFixed(1);
    const totalMB = total ? (total / BYTES_PER_MB).toFixed(1) : '?';
    dom.progressFill.style.width = total ? `${(received / total) * 100}%` : '50%';
    dom.progressPercent.textContent = total ? `${pct}%` : '...';
    dom.progressSize.textContent = `${receivedMB} MB / ${totalMB} MB`;
    if (elapsedSeconds > 0.5) {
        dom.progressSpeed.textContent = ((received / BYTES_PER_MB) / elapsedSeconds).toFixed(1) + ' MB/s';
    }
}

export function resetProgressUI() {
    dom.progressContainer.classList.remove('hidden');
    dom.hashDisplay.classList.add('hidden');
    dom.pauseBtn.classList.remove('hidden');
    dom.resumeBtn.classList.add('hidden');
    state.paused = false;
    state.cancelDownload = false;
    state.receivedBytes = 0;
    state.totalBytes = 0;
}

export function finishProgressUI() {
    dom.pauseBtn.classList.add('hidden');
    dom.resumeBtn.classList.add('hidden');
}

// ===== SHA256 hashing (guarded for large files) =====
// crypto.subtle.digest() needs the ENTIRE file loaded into one contiguous
// buffer at once. On mobile browsers this can silently fail, hang, or crash
// the tab for files in the several-hundred-MB+ range, so files above the
// limit skip hashing entirely rather than risk breaking the download itself.
export async function hashAndDisplay(blob) {
    if (blob.size > HASH_SIZE_LIMIT_BYTES) {
        log(`ℹ️ Skipping SHA256 (file is ${(blob.size / BYTES_PER_MB).toFixed(0)}MB — over the ${HASH_SIZE_LIMIT_BYTES / BYTES_PER_MB}MB limit for hashing on-device).`, 'info');
        return;
    }
    if (typeof crypto === 'undefined' || !crypto.subtle) {
        log('ℹ️ Skipping SHA256 — this browser doesn\'t support the Web Crypto API needed to hash files.', 'info');
        return;
    }
    try {
        const buf = await blob.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', buf);
        dom.hashValue.textContent = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
        dom.hashDisplay.classList.remove('hidden');
        log('🔐 SHA256 hash generated', 'done');
    } catch (err) {
        log(`⚠️ Hash calculation failed: ${err.message}`, 'warn');
    }
}
