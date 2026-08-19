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

// ===== SHA256 hashing (guarded for large files) =====
// crypto.subtle.digest() needs the ENTIRE file loaded into one contiguous
// buffer at once. On mobile browsers this can silently fail, hang, or crash
// the tab for files in the several-hundred-MB+ range — that's almost
// certainly what caused the earlier "hash error" you saw on an 800MB file.
// Skipping the hash above this threshold trades off integrity verification
// for not breaking the download itself, which already matters more.
const HASH_SIZE_LIMIT_BYTES = 300 * 1024 * 1024; // 300MB

async function hashAndDisplay(blob) {
    if (blob.size > HASH_SIZE_LIMIT_BYTES) {
        log(`ℹ️ Skipping SHA256 (file is ${(blob.size / 1024 / 1024).toFixed(0)}MB — over the ${HASH_SIZE_LIMIT_BYTES / 1024 / 1024}MB limit for hashing on-device).`, 'info');
        return;
    }
    try {
        const buf = await blob.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', buf);
        hashValue.textContent = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
        hashDisplay.style.display = 'flex';
        log('🔐 SHA256 hash generated', 'done');
    } catch (err) {
        log(`⚠️ Hash calculation failed: ${err.message}`, 'warn');
    }
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

// ===== Strict CDN URL validation =====
// The old check (`startsWith('https://') && includes('telegram.org')`) is
// trivially spoofed — e.g. "https://telegram.org.evil.com/x" or
// "https://evil.com/?redirect=telegram.org" both pass that test. This does
// a real parse: exact hostname match, a locked-down path shape, and an
// extension allow-list, so nothing outside cdn.telegram.org/file/<name>.<ext>
// gets through.
const ALLOWED_CDN_HOST = 'cdn.telegram.org';
const ALLOWED_EXTENSIONS = new Set([
    'zip','rar','7z','gz','bz2','xz','tar',
    'pdf','doc','docx','xls','xlsx','ppt','pptx',
    'mp4','mkv','avi','mov','wmv','flv','webm',
    'mp3','wav','flac','aac','ogg',
    'jpg','jpeg','png','gif','bmp','webp','svg',
    'exe','msi','apk','dmg','pkg',
    'iso','img','bin',
    'txt','log','csv','json','xml','yml','yaml',
]);

function isValidCdnUrl(input) {
    let parsed;
    try {
        parsed = new URL(input);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname !== ALLOWED_CDN_HOST) return false;
    // Path must be exactly /file/<safe-filename>, no traversal, no extra segments.
    const match = parsed.pathname.match(/^\/file\/([A-Za-z0-9._-]+)$/);
    if (!match) return false;
    const filename = match[1];
    if (filename.includes('..')) return false;
    const ext = filename.split('.').pop().toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) return false;
    return true;
}

useManualBtn.addEventListener('click', () => {
    const url = manualCdnInput.value.trim();
    if (isValidCdnUrl(url)) {
        manualCdnUrl = url;
        log(`✅ Manual CDN set: ${url}`, 'done');
        downloadTelegramFile(url);
    } else {
        log('❌ Invalid CDN URL. Must look like https://cdn.telegram.org/file/name.ext with a recognized extension.', 'error');
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
        if (!isValidCdnUrl(cdnUrl)) {
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
                await hashAndDisplay(blob);
                
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
        await hashAndDisplay(blob);
    } catch (err) {
        if (err.message === 'Download cancelled') {
            log('⚠️ Download cancelled by user.', 'warn');
        } else {
            log(`❌ Download failed: ${err.message}`, 'error');
        }
    } finally {
        isDownloading = false;
        pauseBtn.style.display = 'none';
        resumeBtn.style.display = 'none';
    }
}

// ===== Save file (File System Access API if a folder was picked, else normal browser download) =====
async function saveFileWithFolder(blob, fileName) {
    if (selectedFolderHandle) {
        try {
            const fileHandle = await selectedFolderHandle.getFileHandle(fileName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(blob);
            await writable.close();
            log(`💾 Saved to folder: ${fileName}`, 'done');
            return;
        } catch (err) {
            log(`⚠️ Folder save failed (${err.message}), falling back to browser download.`, 'warn');
        }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// ===== Wire up main controls (previously missing — this was the main bug) =====
grabBtn.addEventListener('click', () => {
    const input = fileUrlInput.value.trim();
    if (!input) {
        log('⚠️ Please paste a URL first.', 'warn');
        return;
    }
    grabAny(input);
});

fileUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') grabBtn.click();
});

bulkGrabBtn.addEventListener('click', async () => {
    const lines = bulkUrls.value.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) {
        log('⚠️ Please paste at least one URL.', 'warn');
        return;
    }
    log(`📥 Starting bulk grab of ${lines.length} URL(s)...`, 'info');
    for (const line of lines) {
        if (isDownloading) {
            // wait for the current download to finish before starting the next
            await new Promise(resolve => {
                const check = () => {
                    if (!isDownloading) resolve();
                    else setTimeout(check, 300);
                };
                check();
            });
        }
        await grabAny(line);
    }
    log('✅ Bulk grab finished.', 'done');
});

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (!file || !file.name.endsWith('.txt')) {
        log('⚠️ Please drop a .txt file with URLs.', 'warn');
        return;
    }
    const text = await file.text();
    bulkUrls.value = text;
    log(`📁 Loaded ${text.split('\n').filter(Boolean).length} URL(s) from ${file.name}`, 'info');
});

copyHashBtn.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(hashValue.textContent);
        log('📋 Hash copied to clipboard.', 'done');
    } catch (err) {
        log(`⚠️ Copy failed: ${err.message}`, 'warn');
    }
});

pauseBtn.addEventListener('click', () => {
    paused = true;
    pauseBtn.style.display = 'none';
    resumeBtn.style.display = 'inline-block';
    log('⏸ Paused.', 'warn');
});

resumeBtn.addEventListener('click', () => {
    paused = false;
    resumeBtn.style.display = 'none';
    pauseBtn.style.display = 'inline-block';
    log('▶ Resumed.', 'info');
});

// =====================================================================
// ===== MTProto (Option B) — real Telegram user login via backend =====
// Supports downloads up to 2GB (4GB with Telegram Premium), because the
// limit lives on the account, not on this client. Requires the small
// Node.js backend from the /server folder to be deployed somewhere.
// =====================================================================

const backendUrlInput = document.getElementById('backendUrl');
const phoneInput = document.getElementById('phoneInput');
const sendCodeBtn = document.getElementById('sendCodeBtn');
const codeStep = document.getElementById('codeStep');
const codeInput = document.getElementById('codeInput');
const submitCodeBtn = document.getElementById('submitCodeBtn');
const passwordStep = document.getElementById('passwordStep');
const passwordInput = document.getElementById('passwordInput');
const submitPasswordBtn = document.getElementById('submitPasswordBtn');
const mtprotoLoggedOut = document.getElementById('mtprotoLoggedOut');
const mtprotoLoggedIn = document.getElementById('mtprotoLoggedIn');
const logoutBtn = document.getElementById('logoutBtn');
const mtprotoStatus = document.getElementById('mtprotoStatus');

let mtSessionId = localStorage.getItem('telegrab-mt-session') || null;
let mtLoggedIn = false;

// ===== Encrypt the MTProto session string before it touches localStorage =====
// A raw session string in localStorage is effectively a saved password for
// the Telegram account — anyone with access to the browser's storage (another
// app, a shared device, a browser extension) could lift it and log in as you.
// This encrypts it with a key derived from a PIN only you know, so the stored
// value is useless without that PIN. It's not a hardware-backed vault, but
// it's a real improvement over plaintext for a browser-only app like this.
let sessionPin = null; // kept in memory only for this tab's lifetime

async function deriveKey(pin, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

async function encryptSessionString(plaintext, pin) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pin, salt);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
    const combined = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
    combined.set(salt, 0);
    combined.set(iv, salt.length);
    combined.set(new Uint8Array(ciphertext), salt.length + iv.length);
    return btoa(String.fromCharCode(...combined));
}

async function decryptSessionString(stored, pin) {
    const combined = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
    const salt = combined.slice(0, 16);
    const iv = combined.slice(16, 28);
    const ciphertext = combined.slice(28);
    const key = await deriveKey(pin, salt);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
}

function getPin(promptMessage) {
    if (sessionPin) return sessionPin;
    const entered = window.prompt(promptMessage);
    if (entered) sessionPin = entered;
    return sessionPin;
}

async function saveEncryptedSessionString(plainSessionString) {
    const pin = getPin('Set a PIN to protect your saved Telegram login on this device (4+ digits, remember it — it cannot be recovered):');
    if (!pin) {
        log('⚠️ No PIN set — login won\'t survive a backend restart. You can still use the app normally.', 'warn');
        return;
    }
    try {
        const encrypted = await encryptSessionString(plainSessionString, pin);
        localStorage.setItem('telegrab-mt-sessionstring', encrypted);
    } catch (err) {
        log(`⚠️ Could not save encrypted session: ${err.message}`, 'warn');
    }
}

function mtBackend() {
    return (backendUrlInput.value || '').trim().replace(/\/+$/, '');
}

// Restore saved backend URL
const savedBackend = localStorage.getItem('telegrab-backend-url');
if (savedBackend) backendUrlInput.value = savedBackend;
backendUrlInput.addEventListener('change', () => {
    localStorage.setItem('telegrab-backend-url', backendUrlInput.value.trim());
});

function setMtStatus(msg) {
    mtprotoStatus.textContent = msg || '';
}

function showLoggedIn(isIn) {
    mtLoggedIn = isIn;
    mtprotoLoggedIn.style.display = isIn ? 'block' : 'none';
    mtprotoLoggedOut.style.display = isIn ? 'none' : 'block';
}

async function checkMtStatus() {
    const backend = mtBackend();
    if (!backend) return;

    // First try the normal (in-memory) session, in case backend hasn't restarted.
    if (mtSessionId) {
        try {
            const res = await fetch(`${backend}/auth/status?sessionId=${mtSessionId}`);
            const data = await res.json();
            if (data.loggedIn) {
                showLoggedIn(true);
                log('🔐 MTProto session restored — logged in.', 'done');
                return;
            }
        } catch (err) {
            // backend unreachable; fall through to try resume
        }
    }

    // Backend forgot us (likely redeployed) — try resuming with the saved
    // session string instead, which logs back in without needing the code again.
    const savedEncrypted = localStorage.getItem('telegrab-mt-sessionstring');
    if (savedEncrypted) {
        const pin = getPin('Enter your PIN to resume your saved Telegram login:');
        if (!pin) return; // user cancelled — stay logged out, no harm done
        let savedSessionString;
        try {
            savedSessionString = await decryptSessionString(savedEncrypted, pin);
        } catch (err) {
            log('❌ Wrong PIN — could not unlock saved login. Please log in again.', 'error');
            sessionPin = null;
            return;
        }
        try {
            setMtStatus('Resuming previous login…');
            const res = await fetch(`${backend}/auth/resume`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionString: savedSessionString }),
            });
            const data = await res.json();
            if (res.ok && data.status === 'logged_in') {
                mtSessionId = data.sessionId;
                localStorage.setItem('telegrab-mt-session', mtSessionId);
                showLoggedIn(true);
                setMtStatus('');
                log('🔐 Logged back in automatically (session resumed).', 'done');
                return;
            }
            // Saved session no longer valid — clear it so we don't keep retrying.
            localStorage.removeItem('telegrab-mt-sessionstring');
            localStorage.removeItem('telegrab-mt-session');
            setMtStatus('');
        } catch (err) {
            setMtStatus('');
        }
    }
}
checkMtStatus();

sendCodeBtn.addEventListener('click', async () => {
    const backend = mtBackend();
    const phone = phoneInput.value.trim();
    if (!backend) { log('⚠️ Enter a Backend URL first.', 'warn'); return; }
    if (!phone) { log('⚠️ Enter your phone number (with country code).', 'warn'); return; }

    setMtStatus('Sending code…');
    try {
        const res = await fetch(`${backend}/auth/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to start login');
        mtSessionId = data.sessionId;
        localStorage.setItem('telegrab-mt-session', mtSessionId);
        codeStep.style.display = 'block';
        setMtStatus('Code sent — check Telegram on your other device.');
        log('📩 Login code requested. Check your Telegram app.', 'info');
    } catch (err) {
        setMtStatus('');
        log(`❌ Send code failed: ${err.message}`, 'error');
    }
});

submitCodeBtn.addEventListener('click', async () => {
    const backend = mtBackend();
    const code = codeInput.value.trim();
    if (!code) { log('⚠️ Enter the code you received.', 'warn'); return; }
    setMtStatus('Verifying…');
    try {
        const res = await fetch(`${backend}/auth/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: mtSessionId, field: 'code', value: code }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Verification failed');
        if (data.status === 'logged_in') {
            if (data.sessionString) await saveEncryptedSessionString(data.sessionString);
            showLoggedIn(true);
            setMtStatus('');
            log('✅ MTProto login successful.', 'done');
        } else if (data.needs === 'password') {
            passwordStep.style.display = 'block';
            setMtStatus('2FA enabled — enter your Telegram password.');
        }
    } catch (err) {
        setMtStatus('');
        log(`❌ Code verification failed: ${err.message}`, 'error');
    }
});

submitPasswordBtn.addEventListener('click', async () => {
    const backend = mtBackend();
    const password = passwordInput.value;
    if (!password) { log('⚠️ Enter your 2FA password.', 'warn'); return; }
    setMtStatus('Verifying password…');
    try {
        const res = await fetch(`${backend}/auth/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: mtSessionId, field: 'password', value: password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Password verification failed');
        if (data.status === 'logged_in') {
            if (data.sessionString) await saveEncryptedSessionString(data.sessionString);
            showLoggedIn(true);
            setMtStatus('');
            log('✅ MTProto login successful.', 'done');
        }
    } catch (err) {
        setMtStatus('');
        log(`❌ Password verification failed: ${err.message}`, 'error');
    }
});

logoutBtn.addEventListener('click', async () => {
    const backend = mtBackend();
    try {
        await fetch(`${backend}/auth/logout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: mtSessionId }),
        });
    } catch (_) {}
    localStorage.removeItem('telegrab-mt-session');
    localStorage.removeItem('telegrab-mt-sessionstring');
    mtSessionId = null;
    sessionPin = null;
    showLoggedIn(false);
    codeStep.style.display = 'none';
    passwordStep.style.display = 'none';
    codeInput.value = '';
    passwordInput.value = '';
    log('👋 Logged out of MTProto.', 'info');
});

// ===== Stream a fetch Response into the same progress/hash/save pipeline =====
async function streamResponseToFile(response, fileName) {
    const contentLength = response.headers.get('content-length');
    totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
    if (totalBytes > 0) log(`📊 File size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`, 'info');

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    startTime = performance.now();

    while (true) {
        if (cancelDownload) { await reader.cancel(); throw new Error('Download cancelled'); }
        if (paused) {
            await new Promise((resolve) => {
                const checkPause = () => { if (!paused) resolve(); else setTimeout(checkPause, 200); };
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
            progressSpeed.textContent = ((received / 1024 / 1024) / elapsed).toFixed(1) + ' MB/s';
        }
    }

    const blob = new Blob(chunks);
    await saveFileWithFolder(blob, fileName);
    log(`✅ Complete: ${(blob.size / 1024 / 1024).toFixed(2)} MB`, 'done');
    await hashAndDisplay(blob);
}

// ===== Download via the MTProto backend (real user login, up to 2GB/4GB) =====
async function downloadViaMTProto(link) {
    const backend = mtBackend();
    if (isDownloading) { log('⚠️ Download already in progress.', 'warn'); return; }
    isDownloading = true;
    progressContainer.style.display = 'block';
    hashDisplay.style.display = 'none';
    pauseBtn.style.display = 'inline-block';
    resumeBtn.style.display = 'none';
    paused = false;
    cancelDownload = false;
    receivedBytes = 0;
    totalBytes = 0;

    try {
        log(`⬇️ Requesting ${link} via MTProto…`, 'info');
        const url = `${backend}/download?sessionId=${encodeURIComponent(mtSessionId)}&link=${encodeURIComponent(link)}`;
        const response = await fetch(url);
        if (!response.ok) {
            let msg = `HTTP ${response.status}`;
            try { const j = await response.json(); if (j.error) msg = j.error; } catch (_) {}
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
        isDownloading = false;
        pauseBtn.style.display = 'none';
        resumeBtn.style.display = 'none';
    }
}

// ===== Native browser download (no JS memory buffering) =====
// Instead of fetch()-ing the file into a growing array of chunks then
// wrapping it all in one giant Blob (which for a 4GB file means the browser
// tab holds 4GB in RAM — the direct cause of the "page unresponsive" /
// slow-down warnings on large files), this just hands the URL to Chrome's
// own downloader. Chrome streams it straight to disk, chunk by chunk,
// without ever loading the whole thing into the page's memory.
// Trade-off: no custom progress bar, no SHA256 hash, no pause/resume —
// Chrome's own download tray takes over and shows its own progress instead.
function triggerNativeDownload(url) {
    log('⬇️ Handed off to your browser\'s downloader — check Chrome\'s download tray for progress.', 'info');
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
}

const nativeDownloadToggle = document.getElementById('nativeDownloadToggle');
const savedNativePref = localStorage.getItem('telegrab-native-download');
if (savedNativePref !== null) nativeDownloadToggle.checked = savedNativePref === 'true';
nativeDownloadToggle.addEventListener('change', () => {
    localStorage.setItem('telegrab-native-download', nativeDownloadToggle.checked);
});

// ===== Router: use MTProto when logged in, otherwise fall back to CDN guessing =====
async function grabAny(input) {
    if (mtLoggedIn && mtBackend() && input.includes('t.me/')) {
        if (nativeDownloadToggle.checked) {
            const url = `${mtBackend()}/download?sessionId=${encodeURIComponent(mtSessionId)}&link=${encodeURIComponent(input)}`;
            triggerNativeDownload(url);
        } else {
            await downloadViaMTProto(input);
        }
    } else {
        await downloadTelegramFile(input);
    }
}
