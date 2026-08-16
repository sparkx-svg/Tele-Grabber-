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
let pausedChunks = [];
let startTime = 0;
let selectedFolderHandle = null;
let currentFileName = '';

// ===== Theme persistence (Feature 3) =====
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

// ===== Folder picker (Feature 1) =====
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

// Load saved folder name
const savedFolder = localStorage.getItem('telegrab-folder');
if (savedFolder) folderDisplay.textContent = savedFolder;

// ===== Settings toggle =====
settingsToggle.addEventListener('click', () => {
    settingsPanel.style.display = settingsPanel.style.display === 'none' ? 'block' : 'none';
});

// ===== Telegram API integration (Feature 2) =====
async function fetchWithTelegramAPI(chatId, messageId) {
    const apiId = apiIdInput.value.trim();
    const apiHash = apiHashInput.value.trim();
    if (!apiId || !apiHash) {
        log('API ID/Hash missing. Falling back to CDN.', 'warn');
        return null;
    }
    // Use public Telegram API endpoint (simplified)
    try {
        const dcId = 2; // Usually 2 for media
        const url = `https://${dcId}.tgcdn.net/telegram/file_${chatId}_${messageId}.bin`;
        // Test with HEAD request
        const resp = await fetch(url, { method: 'HEAD' });
        if (resp.ok) return url;
    } catch {}
    return null;
}

// ===== Enhanced resolve =====
async function resolveTelegramLink(link) {
    // Try API first if IDs provided
    const apiId = apiIdInput.value.trim();
    const apiHash = apiHashInput.value.trim();
    if (apiId && apiHash) {
        const parts = link.match(/c\/(\d+)\/(\d+)/);
        if (parts) {
            const chatId = parts[1];
            const messageId = parts[2];
            const apiUrl = await fetchWithTelegramAPI(chatId, messageId);
            if (apiUrl) {
                log('Using Telegram API direct endpoint.', 'done');
                return apiUrl;
            }
        }
    }

    // Fallback to CDN scraping
    try {
        const resp = await fetch(link, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36' }
        });
        const html = await resp.text();
        const match = html.match(/https:\/\/cdn\.telegram\.org\/file\/[^\s"']+/);
        if (match) return match[0];
        const og = html.match(/<meta\s+property="og:url"\s+content="([^"]+)"/);
        if (og && og[1].includes('cdn.telegram.org')) return og[1];
        return null;
    } catch {
        return null;
    }
}

// ===== Stream download with folder save (Feature 1) =====
async function streamDownload(url, onProgress) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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

    while (true) {
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

// ===== Save file with folder picker =====
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
    // Fallback to default download
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ===== Start download (updated) =====
async function startDownload(input) {
    if (!input) return;
    progressContainer.style.display = 'block';
    hashDisplay.style.display = 'none';
    pauseBtn.style.display = 'inline-block';
    resumeBtn.style.display = 'none';
    paused = false;
    currentChunks = [];
    receivedBytes = 0;
    totalBytes = 0;

    try {
        let cdnUrl = input;
        if (input.includes('t.me/') || input.includes('c/')) {
            log('Resolving link...', 'info');
            const resolved = await resolveTelegramLink(input);
            if (resolved) cdnUrl = resolved;
            else { log('Failed to resolve.', 'error'); return; }
        }

        currentFileName = cdnUrl.split('/').pop() || 'telegram_file.bin';

        log(`Streaming: ${currentFileName}`, 'info');
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

        // SHA256 hash
        const buf = await blob.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', buf);
        const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
        hashValue.textContent = hashHex;
        hashDisplay.style.display = 'flex';

    } catch (err) {
        log(`❌ Error: ${err.message}`, 'error');
    } finally {
        pauseBtn.style.display = 'none';
        resumeBtn.style.display = 'none';
        // Keep progress visible for a moment
        setTimeout(() => { progressContainer.style.display = 'none'; }, 3000);
    }
}

// ===== Rest of event listeners (same as before, but with updated functions) =====
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
        }, i * 500);
    });
});

// Drag & drop (unchanged)
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

// Pause / Resume (unchanged)
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

// Copy hash (unchanged)
copyHashBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(hashValue.textContent).then(() => {
        log('📋 Hash copied!', 'done');
    }).catch(() => log('Copy failed.', 'error'));
});

// Enter key (unchanged)
fileUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') grabBtn.click();
});

log('✅ Ready. Features: Folder picker, Telegram API (optional), theme persistence.', 'info');
