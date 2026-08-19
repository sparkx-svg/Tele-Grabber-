import { dom } from './dom.js';
import { state } from './state.js';

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
const FILE_TYPES = {
    zip: '📦 ZIP Archive', rar: '📦 RAR Archive', '7z': '📦 7-Zip Archive', gz: '📦 GZ Archive',
    bz2: '📦 BZ2 Archive', xz: '📦 XZ Archive', tar: '📦 TAR Archive',
    pdf: '📄 PDF Document', doc: '📄 Word Document', docx: '📄 Word Document',
    xls: '📊 Excel Spreadsheet', xlsx: '📊 Excel Spreadsheet',
    ppt: '📽️ PowerPoint', pptx: '📽️ PowerPoint',
    mp4: '🎬 MP4 Video', mkv: '🎬 MKV Video', avi: '🎬 AVI Video', mov: '🎬 MOV Video',
    wmv: '🎬 WMV Video', flv: '🎬 FLV Video', webm: '🎬 WebM Video',
    mp3: '🎵 MP3 Audio', wav: '🎵 WAV Audio', flac: '🎵 FLAC Audio', aac: '🎵 AAC Audio', ogg: '🎵 OGG Audio',
    jpg: '🖼️ JPEG Image', jpeg: '🖼️ JPEG Image', png: '🖼️ PNG Image', gif: '🖼️ GIF Image',
    bmp: '🖼️ BMP Image', webp: '🖼️ WebP Image', svg: '🖼️ SVG Image',
    exe: '⚙️ Windows Executable', msi: '⚙️ Windows Installer', apk: '📱 Android APK',
    dmg: '💻 Mac DMG', pkg: '💻 Mac PKG',
    iso: '💿 ISO Disk Image', img: '💿 IMG Disk Image', bin: '💿 BIN Disk Image',
    txt: '📝 Text File', log: '📝 Log File',
    csv: '📊 CSV Data', json: '📊 JSON Data', xml: '📊 XML Data', yml: '📊 YAML Data', yaml: '📊 YAML Data',
};

export function getFileType(url) {
    const ext = url.split('.').pop().toLowerCase();
    return FILE_TYPES[ext] || `📁 File (${ext.toUpperCase() || 'unknown'})`;
}

export const ALLOWED_EXTENSIONS = new Set(Object.keys(FILE_TYPES));

// ===== Progress bar rendering =====
export function renderProgress(received, total, elapsedSeconds) {
    const pct = total ? ((received / total) * 100).toFixed(1) : '?';
    const receivedMB = (received / 1024 / 1024).toFixed(1);
    const totalMB = total ? (total / 1024 / 1024).toFixed(1) : '?';
    dom.progressFill.style.width = total ? `${(received / total) * 100}%` : '50%';
    dom.progressPercent.textContent = total ? `${pct}%` : '...';
    dom.progressSize.textContent = `${receivedMB} MB / ${totalMB} MB`;
    if (elapsedSeconds > 0.5) {
        dom.progressSpeed.textContent = ((received / 1024 / 1024) / elapsedSeconds).toFixed(1) + ' MB/s';
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
const HASH_SIZE_LIMIT_BYTES = 300 * 1024 * 1024; // 300MB

export async function hashAndDisplay(blob) {
    if (blob.size > HASH_SIZE_LIMIT_BYTES) {
        log(`ℹ️ Skipping SHA256 (file is ${(blob.size / 1024 / 1024).toFixed(0)}MB — over the ${HASH_SIZE_LIMIT_BYTES / 1024 / 1024}MB limit for hashing on-device).`, 'info');
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
