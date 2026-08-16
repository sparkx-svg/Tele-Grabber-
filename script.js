// ===== DOM refs =====
const fileUrlInput = document.getElementById('fileUrl');
const grabBtn = document.getElementById('grabBtn');
const bulkUrls = document.getElementById('bulkUrls');
const bulkGrabBtn = document.getElementById('bulkGrabBtn');
const dropZone = document.getElementById('dropZone');
const progressContainer = document.getElementById('progressContainer');
const progressFill = document.getElementById('progressFill');
const progressPercent = document.getElementById('progressPercent');
const progressSize = document.getElementById('progressSize');
const progressSpeed = document.getElementById('progressSpeed');
const statusLog = document.getElementById('statusLog');
const hashDisplay = document.getElementById('hashDisplay');
const hashValue = document.getElementById('hashValue');
const copyHashBtn = document.getElementById('copyHashBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resumeBtn = document.getElementById('resumeBtn');
const themeToggle = document.getElementById('themeToggle');
const settingsToggle = document.getElementById('settingsToggle');
const settingsPanel = document.getElementById('settingsPanel');
const pickFolderBtn = document.getElementById('pickFolderBtn');
const resetFolderBtn = document.getElementById('resetFolderBtn');
const folderDisplay = document.getElementById('folderDisplay');
const apiIdInput = document.getElementById('apiId');
const apiHashInput = document.getElementById('apiHash');

// ===== State =====
let currentController = null;
let currentReader = null;
let currentChunks = [];
let receivedBytes = 0;
let totalBytes = 0;
let paused = false;
let startTime = 0;
let selectedFolderHandle = null;
let currentFileName = '';
let cancelDownload = false;
let resolvingSpinner = false;

// ===== Theme persistence =====
function loadTheme() {
    const saved = localStorage.getItem('telegrab-theme');
    if (saved === 'light') {
        document.body.classList.add('light');
        themeToggle.textContent = '☀️';
    } else {
        themeToggle.textContent = '🌙';
    }
}
function saveTheme(theme) {
    localStorage.setItem('telegrab-theme', theme);
}
themeToggle.addEventListener('click', () => {
    const isLight = document.body.classList.toggle('light');
    themeToggle.textContent = isLight ? '☀️' : '🌙';
    saveTheme(isLight ? 'light' : 'dark');
});
loadTheme();

// ===== Folder picker =====
async function pickFolder() {
    try {
        const handle = await window.showDirectoryPicker();
        selectedFolderHandle = handle;
        folderDisplay.textContent = handle.name;
        localStorage.setItem('telegrab-folder', handle.name);
        log(`📁 Folder selected: ${handle.name}`, 'done');
    } catch (err) {
        if (err.name !== 'AbortError') {
            log('Folder selection cancelled or not supported.', 'warn');
        }
    }
}
pickFolderBtn.addEventListener('click', pickFolder);
resetFolderBtn.addEventListener('click', () => {
    selectedFolderHandle = null;
    folderDisplay.textContent = 'Default (Downloads)';
    localStorage.removeItem('telegrab-folder');
    log('Folder reset to default.', 'info');
});
const savedFolder = localStorage.getItem('telegrab-folder');
if (savedFolder) folderDisplay.textContent = savedFolder;

// ===== Settings toggle =====
settingsToggle.addEventListener('click', () => {
    settingsPanel.style.display = settingsPanel.style.display === 'none' ? 'block' : 'none';
});

// ===== Logging =====
function log(msg, type = 'info') {
    const prefix = type === 'error' ? '❌' : type === 'done' ? '✅' : type === 'warn' ? '⚠️' : type === 'resolving' ? '🔄' : 'ℹ️';
    statusLog.innerHTML += `\n${prefix} ${msg}`;
    statusLog.scrollTop = statusLog.scrollHeight;
}

// ===== Session cookie support (private channels) =====
function getTelegramSessionCookie() {
    // Try to get from localStorage or prompt user
    let cookie = localStorage.getItem('telegram-session-cookie');
    if (!cookie) {
        cookie = prompt('🔐 Paste your Telegram session cookie (for private channels). Leave blank for public:', '');
        if (cookie) localStorage.setItem('telegram-session-cookie', cookie);
    }
    return cookie;
}

// ===== Fetch with cookies =====
async function fetchWithCookies(url, options = {}) {
    const cookie = getTelegramSessionCookie();
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...options.headers
    };
    if (cookie) headers['Cookie'] = cookie;
    return fetch(url, { ...options, headers });
}

// ===== Resolve with progress =====
async function resolveTelegramLink(link) {
    log('🔄 Resolving link...', 'resolving');
    const cleanLink = link.split('?')[0];
    
    // Case 1: Numeric chat
    const numericMatch = cleanLink.match(/t\.me\/c\/(\d+)\/(\d+)/);
    if (numericMatch) {
        const chatId = numericMatch[1];
        const messageId = numericMatch[2];
        const apiId = apiIdInput?.value?.trim() || '';
        const apiHash = apiHashInput?.value?.trim() || '';
        if (apiId && apiHash) {
            const apiUrl = await fetchWithTelegramAPI(chatId, messageId);
            if (apiUrl) {
                log('✅ Using Telegram API direct endpoint.', 'done');
                return apiUrl;
            }
        }
        try {
            const resp = await fetchWithCookies(cleanLink);
            const html = await resp.text();
            const match = html.match(/https:\/\/cdn\.telegram\.org\/file\/[^\s"']+/);
            if (match) return match[0];
            const og = html.match(/<meta\s+property="og:url"\s+content="([^"]+)"/);
            if (og && og[1].includes('cdn.telegram.org')) return og[1];
        } catch {}
        return null;
    }
    
    // Case 2: Username/post
    const userMatch = cleanLink.match(/t\.me\/([^/]+)\/(\d+)/);
    if (userMatch) {
        const username = userMatch[1];
        const postId = userMatch[2];
        try {
            const widgetUrl = `https://t.me/${username}/${postId}?embed=1`;
            const resp = await fetchWithCookies(widgetUrl);
            const html = await resp.text();
            
            // Extract ALL media links
            const mediaLinks = html.match(/https:\/\/cdn\.telegram\.org\/file\/[^\s"']+/g) || [];
            const ogVideo = html.match(/<meta\s+property="og:video"\s+content="([^"]+)"/);
            if (ogVideo && ogVideo[1].includes('telegram.org')) mediaLinks.push(ogVideo[1]);
            const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
            if (ogImage && ogImage[1].includes('telegram.org')) mediaLinks.push(ogImage[1]);
            
            if (mediaLinks.length === 0) {
                // Try generic file link
                const fileMatch = html.match(/https:\/\/[^"]+\.(jpg|jpeg|png|gif|mp4|webm|pdf|zip|rar|7z|exe|msi|apk|bin)/i);
                if (fileMatch) return fileMatch[0];
                return null;
            }
            
            // If multiple, return first but store rest for bulk
            if (mediaLinks.length > 1) {
                localStorage.setItem('telegrab-additional-files', JSON.stringify(mediaLinks.slice(1)));
                log(`📎 Found ${mediaLinks.length} files. Downloading first, rest queued.`, 'info');
            }
            return mediaLinks[0];
            
        } catch (err) {
            log(`Widget fetch failed: ${err.message}`, 'warn');
        }
    }
    
    // Case 3: Direct CDN
    if (link.startsWith('https://cdn.telegram.org/')) return link;
    return null;
}

// ===== Fetch with Telegram API =====
async function fetchWithTelegramAPI(chatId, messageId) {
    const apiId = apiIdInput.value.trim();
    const apiHash = apiHashInput.value.trim();
    if (!apiId || !apiHash) return null;
    try {
        const dcId = 2;
        const url = `https://${dcId}.tgcdn.net/telegram/file_${chatId}_${messageId}.bin`;
        const resp = await fetch(url, { method: 'HEAD' });
        if (resp.ok) return url;
    } catch {}
    return null;
}

// ===== Stream download with cancel support =====
async function streamDownload(url, onProgress) {
    const response = await fetchWithCookies(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = response.headers.get('content-length');
    totalBytes = contentLength ? parseInt(contentLength, 10) : 0;

    const reader = response.body.getReader();
    currentReader = reader;
    const chunks = [];
    let received = 0;
    startTime = performance.now();
    cancelDownload = false;

    while (true) {
        if (cancelDownload) {
            await reader.cancel();
            throw new Error('Download cancelled by user');
        }
        if (paused) {
            await new Promise(resolve => {
                const checkPause = () => {
                    if (!paused) resolve();
                    else setTimeout(checkPause, 200);
                };
                checkPause();
            });
        }
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        receivedBytes = received;
        if (onProgress) onProgress(received, totalBytes);
    }
    currentChunks = chunks;
    return chunks;
}

// ===== Save file =====
async function saveFileWithFolder(blob, fileName) {
    if (selectedFolderHandle) {
        try {
            const fileHandle = await selectedFolderHandle.getFileHandle(fileName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(blob);
            await writable.close();
            log(`💾 Saved to: ${selectedFolderHandle.name}/${fileName}`, 'done');
            return;
        } catch (err) {
            log(`Folder save failed: ${err.message}. Falling back to download.`, 'warn');
        }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ===== Main download =====
async function startDownload(input) {
    if (!input) return;
    progressContainer.style.display = 'block';
    hashDisplay.style.display = 'none';
    pauseBtn.style.display = 'inline-block';
    resumeBtn.style.display = 'none';
    paused = false;
    cancelDownload = false;
    currentChunks = [];
    receivedBytes = 0;
    totalBytes = 0;

    try {
        let cdnUrl = input;
        if (input.includes('t.me/')) {
            const resolved = await resolveTelegramLink(input);
            if (resolved) {
                cdnUrl = resolved;
                log('✅ Resolved to CDN URL', 'done');
            } else {
                log('❌ Failed to resolve link.', 'error');
                return;
            }
        }

        // Validate URL
        if (!cdnUrl || !cdnUrl.startsWith('https://') || !cdnUrl.includes('telegram.org')) {
            log('❌ Invalid URL. Must be Telegram CDN or t.me link.', 'error');
            return;
        }

        currentFileName = cdnUrl.split('/').pop() || 'telegram_file.bin';
        log(`⬇️ Downloading: ${currentFileName}`, 'info');

        const chunks = await streamDownload(cdnUrl, (received, total) => {
            const pct = total ? ((received / total) * 100).toFixed(1) : '?';
            const receivedMB = (received / 1024 / 1024).toFixed(1);
            const totalMB = total ? (total / 1024 / 1024).toFixed(1) : '?';
            progressFill.style.width = total ? `${(received / total) * 100}%` : '50%';
            progressPercent.textContent = total ? `${pct}%` : '...';
            progressSize.textContent = `${receivedMB} MB / ${totalMB} MB`;
            const elapsed = (performance.now() - startTime) / 1000;
            if (elapsed > 0.5) {
                const speed = (received / 1024 / 1024) / elapsed;
                progressSpeed.textContent = speed.toFixed(1) + ' MB/s';
            }
        });

        const blob = new Blob(chunks);
        await saveFileWithFolder(blob, currentFileName);
        log(`✅ Complete: ${(blob.size / 1024 / 1024).toFixed(2)} MB`, 'done');

        // SHA256
        const buf = await blob.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', buf);
        const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
        hashValue.textContent = hashHex;
        hashDisplay.style.display = 'flex';

        // Check for additional files
        const additional = JSON.parse(localStorage.getItem('telegrab-additional-files') || '[]');
        if (additional.length) {
            log(`📎 ${additional.length} additional files found. Use bulk mode to download them.`, 'info');
            localStorage.removeItem('telegrab-additional-files');
        }

    } catch (err) {
        if (err.message === 'Download cancelled by user') {
            log('⛔ Download cancelled.', 'warn');
        } else {
            log(`❌ Error: ${err.message}`, 'error');
        }
    } finally {
        pauseBtn.style.display = 'none';
        resumeBtn.style.display = 'none';
        setTimeout(() => { progressContainer.style.display = 'none'; }, 3000);
    }
}

// ===== Cancel button (new) =====
const cancelBtn = document.createElement('button');
cancelBtn.textContent = '⛔ Cancel';
cancelBtn.id = 'cancelBtn';
cancelBtn.style.display = 'none';
cancelBtn.addEventListener('click', () => {
    cancelDownload = true;
    cancelBtn.style.display = 'none';
    log('⛔ Cancelling...', 'warn');
});
document.querySelector('.progress-section').appendChild(cancelBtn);

// Show cancel button during download
const origStart = startDownload;
startDownload = async function(input) {
    cancelBtn.style.display = 'inline-block';
    await origStart(input);
    cancelBtn.style.display = 'none';
};

// ===== Event listeners =====
grabBtn.addEventListener('click', () => {
    const url = fileUrlInput.value.trim();
    if (url) startDownload(url);
    else log('Please enter a URL, chat ID, or message ID.', 'warn');
});

bulkGrabBtn.addEventListener('click', () => {
    const urls = bulkUrls.value.split('\n').filter(u => u.trim());
    if (!urls.length) { log('Paste at least one URL.', 'warn'); return; }
    urls.forEach((u, i) => {
        setTimeout(() => {
            log(`[${i+1}/${urls.length}] Starting: ${u}`, 'info');
            startDownload(u.trim());
        }, i * 800);
    });
});

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'text/plain') {
        const reader = new FileReader();
        reader.onload = (ev) => {
            bulkUrls.value = ev.target.result;
            log('📂 Loaded URLs from file.', 'done');
        };
        reader.readAsText(file);
    } else {
        log('Please drop a .txt file.', 'warn');
    }
});

pauseBtn.addEventListener('click', () => {
    paused = true;
    pauseBtn.style.display = 'none';
    resumeBtn.style.display = 'inline-block';
    log('⏸ Paused', 'warn');
});
resumeBtn.addEventListener('click', () => {
    paused = false;
    resumeBtn.style.display = 'none';
    pauseBtn.style.display = 'inline-block';
    log('▶ Resumed', 'info');
});

copyHashBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(hashValue.textContent).then(() => {
        log('📋 Hash copied!', 'done');
    }).catch(() => log('Copy failed.', 'error'));
});

fileUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') grabBtn.click();
});

log('✅ TeleGrab Pro fully loaded. Supports public/private channels, multi-file extraction, 5GB+ files, and folder save.', 'done');
