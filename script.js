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

// ===== State =====
let currentController = null;
let currentReader = null;
let currentChunks = [];
let receivedBytes = 0;
let totalBytes = 0;
let paused = false;
let pausedChunks = [];
let startTime = 0;

// ===== Logging =====
function log(msg, type = 'info') {
    const prefix = type === 'error' ? '❌' : type === 'done' ? '✅' : type === 'warn' ? '⚠️' : 'ℹ️';
    statusLog.innerHTML += `\n${prefix} ${msg}`;
    statusLog.scrollTop = statusLog.scrollHeight;
}

// ===== Resolve Telegram link =====
async function resolveTelegramLink(link) {
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

// ===== Download stream =====
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

// ===== Start download =====
async function startDownload(url) {
    if (!url) return;
    progressContainer.style.display = 'block';
    hashDisplay.style.display = 'none';
    pauseBtn.style.display = 'inline-block';
    resumeBtn.style.display = 'none';
    paused = false;
    currentChunks = [];
    receivedBytes = 0;
    totalBytes = 0;

    try {
        let cdnUrl = url;
        if (url.includes('t.me/c/')) {
            log('Resolving Telegram link...', 'info');
            const resolved = await resolveTelegramLink(url);
            if (resolved) cdnUrl = resolved;
            else { log('Failed to resolve link.', 'error'); return; }
        }

        log('Streaming download started...', 'info');
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
        const a = document.createElement('a');
        const fileName = cdnUrl.split('/').pop() || 'telegram_file.bin';
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);

        log(`Download complete: ${(blob.size / 1024 / 1024).toFixed(2)} MB`, 'done');

        // SHA256 (simple)
        const buf = await blob.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', buf);
        const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
        hashValue.textContent = hashHex;
        hashDisplay.style.display = 'flex';

    } catch (err) {
        log(`Error: ${err.message}`, 'error');
    } finally {
        pauseBtn.style.display = 'none';
        resumeBtn.style.display = 'none';
        progressContainer.style.display = 'none';
    }
}

// ===== Event listeners =====
grabBtn.addEventListener('click', () => {
    const url = fileUrlInput.value.trim();
    if (url) startDownload(url);
    else log('Please enter a URL.', 'warn');
});

bulkGrabBtn.addEventListener('click', () => {
    const urls = bulkUrls.value.split('\n').filter(u => u.trim());
    if (!urls.length) { log('Paste at least one URL.', 'warn'); return; }
    urls.forEach((u, i) => {
        setTimeout(() => {
            log(`[${i+1}/${urls.length}] Starting: ${u}`, 'info');
            startDownload(u.trim());
        }, i * 300);
    });
});

// Drag & drop
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
            log('Loaded URLs from file.', 'done');
        };
        reader.readAsText(file);
    } else {
        log('Please drop a .txt file.', 'warn');
    }
});

// Pause / Resume
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

// Theme toggle
themeToggle.addEventListener('click', () => {
    document.body.classList.toggle('light');
    themeToggle.textContent = document.body.classList.contains('light') ? '☀️' : '🌙';
});

// Copy hash
copyHashBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(hashValue.textContent).then(() => {
        log('Hash copied!', 'done');
    }).catch(() => log('Copy failed.', 'error'));
});

// Enter key
fileUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') grabBtn.click();
});

log('Ready. Enter a Telegram file URL or drop a .txt with multiple URLs.', 'info');
