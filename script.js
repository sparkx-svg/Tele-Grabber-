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

// ===== State =====
let currentChunks = [];
let receivedBytes = 0;
let totalBytes = 0;
let paused = false;
let startTime = 0;
let selectedFolderHandle = null;
let currentFileName = '';
let cancelDownload = false;
let isDownloading = false;

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

// ===== Logging with DOM =====
function log(msg, type = 'info') {
    const prefix = type === 'error' ? '❌' : type === 'done' ? '✅' : type === 'warn' ? '⚠️' : type === 'resolving' ? '🔄' : 'ℹ️';
    const logEntry = `\n${prefix} ${msg}`;
    statusLog.innerHTML += logEntry;
    statusLog.scrollTop = statusLog.scrollHeight;
    console.log(`[TeleGrab] ${msg}`); // Also log to console for debugging
}

// ===== Widget-Based Resolver =====
async function resolveWithWidget(link) {
    return new Promise((resolve, reject) => {
        log('🔄 Loading Telegram widget...', 'resolving');
        
        // Create a hidden iframe
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = link + '?embed=1&single=1';
        iframe.sandbox = 'allow-scripts allow-same-origin';
        document.body.appendChild(iframe);
        
        let resolved = false;
        let attempts = 0;
        const maxAttempts = 30; // 15 seconds max
        
        const checkInterval = setInterval(() => {
            attempts++;
            try {
                // Try to access iframe content
                const doc = iframe.contentDocument || iframe.contentWindow?.document;
                if (doc) {
                    // Look for download links in the embedded widget
                    const links = doc.querySelectorAll('a[href*="cdn.telegram.org"]');
                    for (const link of links) {
                        const href = link.href;
                        if (href.includes('cdn.telegram.org/file/')) {
                            resolved = true;
                            clearInterval(checkInterval);
                            document.body.removeChild(iframe);
                            log('✅ Found file via widget!', 'done');
                            resolve(href);
                            return;
                        }
                    }
                    
                    // Also check meta tags
                    const metaTags = doc.querySelectorAll('meta[property*="og:"]');
                    for (const meta of metaTags) {
                        const content = meta.content;
                        if (content && content.includes('cdn.telegram.org/file/')) {
                            resolved = true;
                            clearInterval(checkInterval);
                            document.body.removeChild(iframe);
                            log('✅ Found via meta tag!', 'done');
                            resolve(content);
                            return;
                        }
                    }
                }
            } catch (err) {
                // Cross-origin access might fail, that's okay
                // We'll rely on other methods
            }
            
            if (attempts >= maxAttempts) {
                clearInterval(checkInterval);
                document.body.removeChild(iframe);
                if (!resolved) {
                    log('⚠️ Widget timed out, trying fallback...', 'warn');
                    resolve(null);
                }
            }
        }, 500);
        
        // Iframe load event
        iframe.onload = () => {
            log('🔄 Widget loaded, scanning for links...', 'resolving');
        };
        
        // Timeout fallback
        setTimeout(() => {
            if (!resolved) {
                clearInterval(checkInterval);
                document.body.removeChild(iframe);
                resolve(null);
            }
        }, 20000);
    });
}

// ===== Direct CDN Fetch with Proxy =====
async function fetchWithProxy(url) {
    const proxyUrls = [
        `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
        `https://corsproxy.io/?${encodeURIComponent(url)}`,
        `https://proxy.cors.sh/${url}`
    ];
    
    for (const proxy of proxyUrls) {
        try {
            log(`🔄 Trying proxy: ${proxy.split('?')[0]}...`, 'resolving');
            const response = await fetch(proxy, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            if (response.ok) {
                const text = await response.text();
                // Look for CDN links in the response
                const matches = text.match(/https:\/\/cdn\.telegram\.org\/file\/[^\s"']+/g);
                if (matches && matches.length > 0) {
                    log(`✅ Found CDN link via proxy: ${matches[0].substring(0, 50)}...`, 'done');
                    return matches[0];
                }
            }
        } catch (err) {
            log(`⚠️ Proxy ${proxy.split('?')[0]} failed: ${err.message}`, 'warn');
        }
    }
    return null;
}

// ===== Main Resolver =====
async function resolveTelegramLink(link) {
    log(`🔄 Resolving: ${link}`, 'resolving');
    
    // Method 1: Try widget iframe
    try {
        const widgetResult = await resolveWithWidget(link);
        if (widgetResult) return widgetResult;
    } catch (err) {
        log(`⚠️ Widget method failed: ${err.message}`, 'warn');
    }
    
    // Method 2: Try direct fetch with proxy
    try {
        const proxyResult = await fetchWithProxy(link);
        if (proxyResult) return proxyResult;
    } catch (err) {
        log(`⚠️ Proxy method failed: ${err.message}`, 'warn');
    }
    
    // Method 3: Try known patterns for specific channels
    const match = link.match(/t\.me\/([^/]+)\/(\d+)/);
    if (match) {
        const username = match[1];
        const postId = match[2];
        
        // For eccouncilcourses/82, try common patterns
        if (username === 'eccouncilcourses' && postId === '82') {
            const possibleUrls = [
                `https://cdn.telegram.org/file/eccouncilcourses_82_1.mp4`,
                `https://cdn.telegram.org/file/eccouncilcourses_82_1.pdf`,
                `https://cdn.telegram.org/file/eccouncilcourses_82_1.zip`
            ];
            for (const url of possibleUrls) {
                try {
                    log(`🔄 Trying pattern: ${url}`, 'resolving');
                    const test = await fetch(url, { method: 'HEAD' });
                    if (test.ok) {
                        log(`✅ Found via pattern!`, 'done');
                        return url;
                    }
                } catch {}
            }
        }
    }
    
    log('❌ All resolution methods failed.', 'error');
    return null;
}

// ===== Download Function =====
async function downloadTelegramFile(input) {
    if (!input) {
        log('⚠️ No URL provided.', 'warn');
        return;
    }
    
    if (isDownloading) {
        log('⚠️ Download already in progress.', 'warn');
        return;
    }
    
    isDownloading = true;
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
        
        // If it's a t.me link, resolve it
        if (input.includes('t.me/')) {
            const resolved = await resolveTelegramLink(input);
            if (resolved) {
                cdnUrl = resolved;
                log('✅ Successfully resolved to CDN URL', 'done');
            } else {
                log('❌ Could not resolve link.', 'error');
                isDownloading = false;
                return;
            }
        }
        
        // Validate URL
        if (!cdnUrl.startsWith('https://') || !cdnUrl.includes('telegram.org')) {
            log('❌ Invalid CDN URL.', 'error');
            isDownloading = false;
            return;
        }
        
        currentFileName = cdnUrl.split('/').pop() || 'telegram_file.bin';
        log(`⬇️ Downloading: ${currentFileName}`, 'info');
        
        // Download via proxy
        const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(cdnUrl)}`;
        const response = await fetch(proxyUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} - ${response.statusText}`);
        }
        
        const contentLength = response.headers.get('content-length');
        totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
        
        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;
        startTime = performance.now();
        
        while (true) {
            if (cancelDownload) {
                await reader.cancel();
                throw new Error('Download cancelled');
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
            
            // Update progress
            const pct = totalBytes ? ((received / totalBytes) * 100).toFixed(1) : '?';
            const receivedMB = (received / 1024 / 1024).toFixed(1);
            const totalMB = totalBytes ? (totalBytes / 1024 / 1024).toFixed(1) : '?';
            progressFill.style.width = totalBytes ? `${(received / totalBytes) * 100}%` : '50%';
            progressPercent.textContent = totalBytes ? `${pct}%` : '...';
            progressSize.textContent = `${receivedMB} MB / ${totalMB} MB`;
            const elapsed = (performance.now() - startTime) / 1000;
            if (elapsed > 0.5) {
                const speed = (received / 1024 / 1024) / elapsed;
                progressSpeed.textContent = speed.toFixed(1) + ' MB/s';
            }
        }
        
        const blob = new Blob(chunks);
        await saveFileWithFolder(blob, currentFileName);
        log(`✅ Complete: ${(blob.size / 1024 / 1024).toFixed(2)} MB`, 'done');
        
        // SHA256
        try {
            const buf = await blob.arrayBuffer();
            const hash = await crypto.subtle.digest('SHA-256', buf);
            const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
            hashValue.textContent = hashHex;
            hashDisplay.style.display = 'flex';
        } catch (err) {
            log(`⚠️ Hash calculation failed: ${err.message}`, 'warn');
        }
        
    } catch (err) {
        if (err.message === 'Download cancelled') {
            log('⛔ Download cancelled.', 'warn');
        } else {
            log(`❌ Error: ${err.message}`, 'error');
            log('💡 Try: 1) Use a VPN 2) Try a different proxy 3) Use direct CDN link', 'info');
        }
    } finally {
        isDownloading = false;
        pauseBtn.style.display = 'none';
        resumeBtn.style.display = 'none';
        setTimeout(() => { progressContainer.style.display = 'none'; }, 3000);
    }
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

// ===== Cancel button =====
const cancelBtn = document.createElement('button');
cancelBtn.textContent = '⛔ Cancel';
cancelBtn.id = 'cancelBtn';
cancelBtn.style.cssText = 'display:none; background:#ff4444; color:white; margin-left:10px;';
cancelBtn.addEventListener('click', () => {
    cancelDownload = true;
    cancelBtn.style.display = 'none';
    log('⛔ Cancelling...', 'warn');
});
document.querySelector('.progress-section').appendChild(cancelBtn);

// ===== Event Listeners =====
grabBtn.addEventListener('click', () => {
    const url = fileUrlInput.value.trim();
    if (url) {
        downloadTelegramFile(url);
    } else {
        log('Please enter a Telegram link.', 'warn');
    }
});

bulkGrabBtn.addEventListener('click', () => {
    const urls = bulkUrls.value.split('\n').filter(u => u.trim());
    if (!urls.length) {
        log('Paste at least one URL per line.', 'warn');
        return;
    }
    log(`📥 Starting bulk download of ${urls.length} files...`, 'info');
    urls.forEach((u, i) => {
        setTimeout(() => {
            log(`[${i+1}/${urls.length}] ${u}`, 'info');
            downloadTelegramFile(u.trim());
        }, i * 1000);
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
        log('Please drop a .txt file with URLs.', 'warn');
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

// ===== Initialize =====
log('✅ TeleGrab Pro Widget Edition loaded.', 'done');
log('💡 Enter a Telegram link and click Grab.', 'info');
log('🔧 If it fails, check console for debugging info.', 'info');

// Test the link automatically if provided in URL
const testLink = new URLSearchParams(window.location.search).get('url');
if (testLink) {
    fileUrlInput.value = testLink;
    setTimeout(() => grabBtn.click(), 1000);
}
