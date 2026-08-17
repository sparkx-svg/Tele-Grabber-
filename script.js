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
let manualCdnUrl = '';

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
    const logEntry = `\n${prefix} ${msg}`;
    statusLog.innerHTML += logEntry;
    statusLog.scrollTop = statusLog.scrollHeight;
    console.log(`[TeleGrab] ${msg}`);
}

// ===== File type detection =====
function getFileType(url) {
    const ext = url.split('.').pop().toLowerCase();
    const types = {
        'zip': '📦 ZIP Archive',
        'rar': '📦 RAR Archive',
        '7z': '📦 7-Zip Archive',
        'gz': '📦 GZ Archive',
        'bz2': '📦 BZ2 Archive',
        'xz': '📦 XZ Archive',
        'tar': '📦 TAR Archive',
        'pdf': '📄 PDF Document',
        'doc': '📄 Word Document',
        'docx': '📄 Word Document',
        'xls': '📊 Excel Spreadsheet',
        'xlsx': '📊 Excel Spreadsheet',
        'ppt': '📽️ PowerPoint',
        'pptx': '📽️ PowerPoint',
        'mp4': '🎬 MP4 Video',
        'mkv': '🎬 MKV Video',
        'avi': '🎬 AVI Video',
        'mov': '🎬 MOV Video',
        'wmv': '🎬 WMV Video',
        'flv': '🎬 FLV Video',
        'webm': '🎬 WebM Video',
        'mp3': '🎵 MP3 Audio',
        'wav': '🎵 WAV Audio',
        'flac': '🎵 FLAC Audio',
        'aac': '🎵 AAC Audio',
        'ogg': '🎵 OGG Audio',
        'jpg': '🖼️ JPEG Image',
        'jpeg': '🖼️ JPEG Image',
        'png': '🖼️ PNG Image',
        'gif': '🖼️ GIF Image',
        'bmp': '🖼️ BMP Image',
        'webp': '🖼️ WebP Image',
        'svg': '🖼️ SVG Image',
        'exe': '⚙️ Windows Executable',
        'msi': '⚙️ Windows Installer',
        'apk': '📱 Android APK',
        'dmg': '💻 Mac DMG',
        'pkg': '💻 Mac PKG',
        'iso': '💿 ISO Disk Image',
        'img': '💿 IMG Disk Image',
        'bin': '💿 BIN Disk Image',
        'txt': '📝 Text File',
        'log': '📝 Log File',
        'csv': '📊 CSV Data',
        'json': '📊 JSON Data',
        'xml': '📊 XML Data',
        'yml': '📊 YAML Data',
        'yaml': '📊 YAML Data',
    };
    return types[ext] || `📁 File (${ext.toUpperCase() || 'unknown'})`;
}

// ===== Add manual CDN input =====
const manualCdnDiv = document.createElement('div');
manualCdnDiv.style.cssText = 'margin: 10px 0; padding: 10px; background: #1a1a2e; border-radius: 8px; border: 1px solid #2a2a4e;';
manualCdnDiv.innerHTML = `
    <label style="color: #00ffcc; font-size: 0.9rem;">🔗 Manual CDN Link (fallback):</label>
    <div style="display: flex; gap: 10px; margin-top: 5px; flex-wrap: wrap;">
        <input type="text" id="manualCdnInput" placeholder="https://cdn.telegram.org/file/..." style="flex: 1; min-width: 200px; padding: 8px; border-radius: 6px; border: 1px solid #2a2a4e; background: #0d0d1a; color: #fff;">
        <button id="useManualBtn" style="padding: 8px 16px; background: #ff6b35; color: #fff; border: none; border-radius: 6px; cursor: pointer;">Use This</button>
        <button id="suggestCdnBtn" style="padding: 8px 16px; background: #2a2a4e; color: #fff; border: none; border-radius: 6px; cursor: pointer;">💡 Suggest</button>
    </div>
`;
settingsPanel.appendChild(manualCdnDiv);

const manualCdnInput = document.getElementById('manualCdnInput');
const useManualBtn = document.getElementById('useManualBtn');
const suggestCdnBtn = document.getElementById('suggestCdnBtn');

useManualBtn.addEventListener('click', () => {
    const url = manualCdnInput.value.trim();
    if (url && url.startsWith('https://') && url.includes('telegram.org')) {
        manualCdnUrl = url;
        log(`✅ Manual CDN set: ${url}`, 'done');
        downloadTelegramFile(url);
    } else {
        log('❌ Invalid CDN URL. Must be https://cdn.telegram.org/file/...', 'error');
    }
});

suggestCdnBtn.addEventListener('click', () => {
    const input = fileUrlInput.value.trim();
    if (input.includes('t.me/')) {
        const match = input.match(/t\.me\/([^/]+)\/(\d+)/);
        if (match) {
            const username = match[1];
            const postId = match[2];
            const suggestions = [
                `https://cdn.telegram.org/file/${username}_${postId}_1.zip`,
                `https://cdn.telegram.org/file/${username}_${postId}.zip`,
                `https://cdn.telegram.org/file/${username}_${postId}_1.rar`,
                `https://cdn.telegram.org/file/${username}_${postId}_1.7z`,
                `https://cdn.telegram.org/file/${username}_${postId}_1.pdf`,
                `https://cdn.telegram.org/file/${username}_${postId}_1.mp4`,
            ];
            manualCdnInput.value = suggestions[0];
            log(`💡 Suggested: ${suggestions[0]}`, 'info');
            log(`💡 Also try: ${suggestions.slice(1).join(', ')}`, 'info');
        }
    }
});

// ===== Extended CDN construction with brute-force =====
function constructCdnUrls(link) {
    const match = link.match(/t\.me\/([^/]+)\/(\d+)/);
    if (!match) return [];
    
    const username = match[1];
    const postId = match[2];
    
    // Prioritize ZIP and common archive formats first
    const extensions = [
        '.zip', '.rar', '.7z', '.gz', '.bz2', '.xz', '.tar',  // Archives FIRST
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', // Documents
        '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', // Videos
        '.mp3', '.wav', '.flac', '.aac', '.ogg', // Audio
        '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', // Images
        '.exe', '.msi', '.apk', '.dmg', '.pkg', // Executables
        '.iso', '.img', '.bin', // Disk images
        '.txt', '.log', '.csv', '.json', '.xml', '.yml', '.yaml', // Text
        '', // No extension
    ];
    
    // Try different file ID patterns
    const patterns = [
        `${username}_${postId}_1`,
        `${username}_${postId}_2`,
        `${username}_${postId}_3`,
        `${username}_${postId}_4`,
        `${username}_${postId}_5`,
        `${username}_${postId}`,
        `${username}_${postId}_file`,
        `${username}_${postId}_media`,
        `file_${postId}`,
        `${postId}_${username}`,
        `${username}_${postId}_download`,
        `${username}_${postId}_archive`,
        `${username}_${postId}_data`,
    ];
    
    const urls = [];
    for (const pattern of patterns) {
        for (const ext of extensions) {
            const url = `https://cdn.telegram.org/file/${pattern}${ext}`;
            urls.push(url);
        }
    }
    
    // Remove duplicates
    return [...new Set(urls)];
}

// ===== Bot resolver (placeholder) =====
async function resolveWithBot(link) {
    // This is a placeholder - you can implement actual bot logic here
    return null;
}

// ===== Main resolver with brute-force =====
async function resolveTelegramLink(link) {
    log(`🔄 Resolving: ${link}`, 'resolving');
    
    // Method 1: Check if it's already a CDN link
    if (link.startsWith('https://cdn.telegram.org/file/')) {
        return link;
    }
    
    // Method 2: Try bot resolver (if available)
    try {
        const botResult = await resolveWithBot(link);
        if (botResult) {
            log('✅ Resolved via bot', 'done');
            return botResult;
        }
    } catch (err) {
        log(`⚠️ Bot method failed: ${err.message}`, 'warn');
    }
    
    // Method 3: Brute-force construction
    const possibleUrls = constructCdnUrls(link);
    log(`🔄 Generated ${possibleUrls.length} possible URLs to try...`, 'resolving');
    
    // Try in batches of 10 to avoid rate limiting
    const batchSize = 10;
    let foundUrl = null;
    
    for (let i = 0; i < possibleUrls.length; i += batchSize) {
        if (cancelDownload) break;
        
        const batch = possibleUrls.slice(i, i + batchSize);
        const promises = batch.map(async (url) => {
            try {
                const test = await fetch(url, { 
                    method: 'HEAD',
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                if (test.ok) {
                    const contentType = test.headers.get('content-type') || 'unknown';
                    const contentLength = test.headers.get('content-length') || 'unknown';
                    const sizeMB = contentLength !== 'unknown' ? (parseInt(contentLength) / 1024 / 1024).toFixed(1) : '?';
                    const fileType = getFileType(url);
                    log(`✅ Found working URL: ${url}`, 'done');
                    log(`📁 Type: ${fileType}, Size: ${sizeMB} MB`, 'info');
                    return url;
                }
            } catch {
                // Silently fail, try next
            }
            return null;
        });
        
        const results = await Promise.all(promises);
        const found = results.find(r => r !== null);
        if (found) {
            foundUrl = found;
            break;
        }
        
        // Log progress every 50 URLs
        if (i % 50 === 0 && i > 0) {
            log(`🔄 Tried ${i}/${possibleUrls.length} URLs...`, 'resolving');
        }
    }
    
    if (foundUrl) {
        return foundUrl;
    }
    
    // Method 4: Try extracting from the page directly
    try {
        log('🔄 Trying direct page extraction...', 'resolving');
        const response = await fetch(link, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html'
            }
        });
        if (response.ok) {
            const html = await response.text();
            const cdnMatches = html.match(/https:\/\/cdn\.telegram\.org\/file\/[^\s"']+/g) || [];
            for (const url of cdnMatches) {
                try {
                    const test = await fetch(url, { method: 'HEAD' });
                    if (test.ok) {
                        log(`✅ Found via page extraction: ${url}`, 'done');
                        const fileType = getFileType(url);
                        log(`📁 Type: ${fileType}`, 'info');
                        return url;
                    }
                } catch {}
            }
        }
    } catch (err) {
        log(`⚠️ Direct parse failed: ${err.message}`, 'warn');
    }
    
    log('❌ All resolution methods failed.', 'error');
    log('💡 Use the manual CDN field above or click "Suggest" for ideas.', 'info');
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
                // Ask user for manual CDN
                log('❌ Could not resolve automatically.', 'error');
                log('💡 Please enter the CDN URL manually in the field above.', 'info');
                log('💡 Click "Suggest" for likely URLs.', 'info');
                manualCdnInput.focus();
                isDownloading = false;
                progressContainer.style.display = 'none';
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
        // If filename doesn't have extension, add .bin
        if (!currentFileName.includes('.')) {
            currentFileName += '.bin';
        }
        
        const fileType = getFileType(cdnUrl);
        log(`📁 File: ${currentFileName}`, 'info');
        log(`📁 Type: ${fileType}`, 'info');
        log(`⬇️ Starting download...`, 'info');
        
        // Try direct fetch first
        try {
            const response = await fetch(cdnUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            if (response.ok) {
                const contentLength = response.headers.get('content-length');
                totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
                
                if (totalBytes > 0) {
                    log(`📊 File size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`, 'info');
                }
                
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
                    log('🔐 SHA256 hash generated', 'done');
                } catch (err) {
                    log(`⚠️ Hash calculation failed: ${err.message}`, 'warn');
                }
                
                isDownloading = false;
                return;
            }
        } catch (err) {
            log(`⚠️ Direct download failed: ${err.message}`, 'warn');
        }
        
        // Fallback: use proxy
        log('🔄 Trying proxy download...', 'resolving');
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
        
        if (totalBytes > 0) {
            log(`📊 File size: ${(totalByte
