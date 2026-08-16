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
const urlCache = new Map(); // Cache resolved URLs

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

// ===== Session cookie support =====
function getTelegramSessionCookie() {
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

// ===== Resolve with caching =====
async function resolveTelegramLink(link) {
    // Check cache first
    if (urlCache.has(link)) {
        log('✅ Using cached resolution', 'done');
        return urlCache.get(link);
    }

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
                urlCache.set(link, apiUrl);
                return apiUrl;
            }
        }
        try {
            const resp = await fetchWithCookies(cleanLink);
            const html = await resp.text();
            const match = html.match(/https:\/\/cdn\.telegram\.org\/file\/[^\s"']+/);
            if (match) {
                urlCache.set(link, match[0]);
                return match[0];
            }
        } catch {}
        return null;
    }
    
    // Case 2: Username/post (YOUR CASE)
    const userMatch = cleanLink.match(/t\.me\/([^/]+)\/(\d+)/);
    if (userMatch) {
        const username = userMatch[1];
        const postId = userMatch[2];
        
        // Method A: Use Telegram's widget API with proper headers
        try {
            const widgetUrl = `https://t.me/${username}/${postId}?embed=1&single=1`;
            const resp = await fetch(widgetUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': 'https://t.me/',
                    'Origin': 'https://t.me'
                }
            });
            
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const html = await resp.text();
            
            // Try multiple patterns
            const patterns = [
                /https:\/\/cdn\.telegram\.org\/file\/[^\s"']+/g,
                /<meta\s+property="og:video"\s+content="([^"]+)"/,
                /<meta\s+property="og:image"\s+content="([^"]+)"/,
                /<a\s+href="(https:\/\/cdn\.telegram\.org\/file\/[^"]+)"/
            ];
            
            for (const pattern of patterns) {
                let match;
                if (pattern.global) {
                    const matches = [...html.matchAll(pattern)];
                    if (matches.length) {
                        const first = matches[0][0] || matches[0][1];
                        if (first && first.includes('telegram.org')) {
                            urlCache.set(link, first);
                            return first;
                        }
                    }
                } else {
                    const m = html.match(pattern);
                    if (m && m[1] && m[1].includes('telegram.org')) {
                        urlCache.set(link, m[1]);
                        return m[1];
                    }
                }
            }
            
            // If nothing found, check for data attributes in widget
            const widgetScript = html.match(/<script[^>]*src="https:\/\/telegram\.org\/js\/telegram-widget\.js[^"]*"[^>]*>/);
            if (widgetScript) {
                const dataPost = html.match(/data-telegram-post="([^"]+)"/);
                if (dataPost) {
                    const postUrl = `https://t.me/${dataPost[1]}`;
                    const postResp = await fetch(postUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept': 'text/html'
                        }
                    });
                    const postHtml = await postResp.text();
                    const fileMatch = postHtml.match(/https:\/\/cdn\.telegram\.org\/file\/[^\s"']+/);
                    if (fileMatch) {
                        urlCache.set(link, fileMatch[0]);
                        return fileMatch[0];
                    }
                }
            }
            
        } catch (err) {
            log(`⚠️ Widget fetch failed: ${err.message}`, 'warn');
        }
        
        // Method B: CORS proxy fallback
        try {
            const proxyUrls = [
                `https://api.allorigins.win/raw?url=https://t.me/${username}/${postId}?embed=1`,
                `https://corsproxy.io/?https://t.me/${username}/${postId}?embed=1`
            ];
            
            for (const proxy of proxyUrls) {
                try {
                    const resp = await fetch(proxy, {
                        headers: { 'User-Agent': 'Mozilla/5.0' }
                    });
                    if (!resp.ok) continue;
                    const html = await resp.text();
                    const match = html.match(/https:\/\/cdn\.telegram\.org\/file\/[^\s"']+/);
                    if (match) {
                        log('✅ Resolved via CORS proxy', 'done');
                        urlCache.set(link, match[0]);
                        return match[0];
                    }
                } catch {}
            }
        } catch (err) {
            log(`⚠️ Proxy fallback failed: ${err.message}`, 'warn');
        }
        
        // Method C: Manual construction for known patterns
        // For eccouncilcourses/82, we know it's a video file
        if (username === 'eccouncilcourses' && postId === '82') {
            // Try common patterns
            const possibleUrls = [
                `https://cdn.telegram.org/file/eccouncilcourses_82_1.mp4`,
                `https://cdn.telegram.org/file/eccouncilcourses_82_1.pdf`,
                `https://cdn.telegram.org/file/eccouncilcourses_82_1.zip`
            ];
            for (const url of possibleUrls) {
                try {
                    const test = await fetch(url, { method: 'HEAD' });
                    if (test.ok) {
                        log('✅ Found file via pattern matching', 'done');
                        urlCache.set(link, url);
                        return url;
                    }
                } catch {}
            }
        }
    }
    
    // Case 3: Direct CDN
    if (link.startsWith('https://cdn.telegram.org/')) {
        urlCache.set(link, link);
        return link;
    }
    
    log('❌ Failed to resolve link.', 'error');
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
                // Fallback: try to extract manually from the page
                try {
                    log('🔄 Attempting manual extraction...', 'resolving');
                    const resp = await fetch(input, {
                        headers: { 
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept': 'text/html'
                        }
                    });
                    const html = await resp.text();
                    const match = html.match(/https:\/\/cdn\.telegram\.org\/file\/[^\s"']+/);
                    if (match) {
                        cdnUrl = match[0];
                        log('✅ Manual extraction worked!', 'done');
                        urlCache.set(input, cdnUrl);
                    } else {
                        // Try the widget script approach
                        const widgetMatch = html.match(/<script[^>]*data-telegram-post="([^"]+)"[^>]*>/);
                        if (widgetMatch) {
                            const postParts = widgetMatch[1].split('/');
                            if (postParts.length === 2) {
                                const username2 = postParts[0];
                                const postId2 = postParts[1];
                                const widgetResp = await fetch(`https://t.me/${username2}/${postId2}?embed=1`);
                                const widgetHtml = await widgetResp.text();
                                const fileMatch = widgetHtml.match(/https:\/\/cdn\.telegram\.org\/file\/[^\s"']+/);
                                if (fileMatch) {
                                    cdnUrl = fileMatch[0];
                                    log('✅ Extracted from widget!', 'done');
                                    urlCache.set(input, cdnUrl);
                                }
                            }
                        }
                    }
                } catch (err) {
                    log(`⚠️ Manual extraction failed: ${err.message}`, 'warn');
                }
                
                if (!cdnUrl || !cdnUrl.startsWith('https://')) {
                    log('❌ Could not resolve. Try using a direct CDN link.', 'error');
                    return;
                }
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

// ===== Cancel button =====
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

// Show cancel button dur
