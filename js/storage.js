import { dom } from './dom.js';
import { state } from './state.js';
import { log } from './ui.js';
import { PBKDF2_ITERATIONS, AES_KEY_LENGTH_BITS, PBKDF2_SALT_LENGTH_BYTES, AES_GCM_IV_LENGTH_BYTES, MIN_PIN_LENGTH } from './constants.js';

// ===== Folder picker (File System Access API) =====
export async function pickFolder() {
    try {
        const handle = await window.showDirectoryPicker();
        state.selectedFolderHandle = handle;
        dom.folderDisplay.textContent = handle.name;
        localStorage.setItem('telegrab-folder', handle.name);
        log(`📁 Folder selected: ${handle.name}`, 'done');
    } catch (err) {
        if (err.name !== 'AbortError') {
            log('Folder selection cancelled or not supported.', 'warn');
        }
    }
}

export function resetFolder() {
    state.selectedFolderHandle = null;
    dom.folderDisplay.textContent = 'Default (Downloads)';
    localStorage.removeItem('telegrab-folder');
    log('Folder reset to default.', 'info');
}

export function restoreFolderDisplay() {
    const savedFolder = localStorage.getItem('telegrab-folder');
    if (savedFolder) dom.folderDisplay.textContent = savedFolder;
}

// ===== Save a completed download (folder handle if picked, else normal browser download) =====
export async function saveFileWithFolder(blob, fileName) {
    if (state.selectedFolderHandle) {
        try {
            const fileHandle = await state.selectedFolderHandle.getFileHandle(fileName, { create: true });
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

// ===== OPFS (Origin Private File System) — the mobile-friendly write target =====
// The folder-picker API above (showDirectoryPicker/createWritable against a
// *user-visible* folder) is desktop-only — Chrome for Android never exposes
// it. Without it, downloads used to fall back to buffering the whole file as
// an in-memory array of chunks, which is exactly what makes a phone's tab
// run out of memory partway through a multi-GB file.
//
// OPFS is a *separate* API that Chrome on Android does support: it's a
// private, sandboxed disk area (invisible in the normal file browser) that
// still lets us open a real FileSystemWritableFileStream and write chunks to
// actual storage instead of RAM. We use it purely as scratch space during
// the download, then hand the finished file off to the browser's normal
// download mechanism (which streams it out of OPFS, not out of a JS array)
// so it lands in the user's visible Downloads folder like any other file.
const OPFS_TEMP_DIR = 'telegrab-tmp';

export function isOpfsSupported() {
    return typeof navigator !== 'undefined' && !!navigator.storage && typeof navigator.storage.getDirectory === 'function';
}

async function getOpfsTempDir() {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(OPFS_TEMP_DIR, { create: true });
}

// Opens (creating if needed) a writable OPFS-backed file to use as a
// download's scratch buffer. Returns both the handle (needed later to read
// the finished bytes back out) and an open writable stream.
export async function openOpfsWritable(fileName) {
    const dir = await getOpfsTempDir();
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    return { fileHandle, writable };
}

// Streams a finished (or partial) OPFS-backed file out to the user's real
// Downloads folder via the browser's normal Blob-download mechanism, then
// removes the OPFS scratch copy. Because `getFile()` returns a lazy File
// handle rather than loading the content into the JS heap, this handoff
// stays memory-light even for multi-GB files — the browser reads the bytes
// off disk (OPFS) as it writes them to Downloads, the same way it would for
// any other object URL download.
export async function deliverOpfsFileToDownloads(fileHandle, downloadName) {
    const file = await fileHandle.getFile();
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return file;
}

export async function deleteOpfsFile(fileName) {
    try {
        const dir = await getOpfsTempDir();
        await dir.removeEntry(fileName);
    } catch {
        // best-effort cleanup — a leftover temp file isn't worth surfacing
        // an error over, and it'll just get overwritten next time anyway
    }
}

// ===== Encrypt the MTProto session string before it touches localStorage =====
// A raw session string in localStorage is effectively a saved password for
// the Telegram account — anyone with access to the browser's storage (another
// app, a shared device, a browser extension) could lift it and log in as you.
// This encrypts it with a key derived from a PIN only the user knows, so the
// stored value is useless without that PIN.

// Some older browsers/contexts (very old mobile browsers, some embedded
// WebViews, non-HTTPS contexts where the Web Crypto API is unavailable)
// don't expose crypto.subtle at all. Rather than let every call site crash
// with a raw TypeError, check once and degrade gracefully: the app still
// works, it just can't persist an encrypted login across backend restarts —
// the user simply logs in again when that happens.
export function isCryptoSupported() {
    return typeof crypto !== 'undefined'
        && !!crypto.subtle
        && typeof crypto.subtle.encrypt === 'function'
        && typeof crypto.subtle.deriveKey === 'function';
}

async function deriveKey(pin, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: AES_KEY_LENGTH_BITS },
        false,
        ['encrypt', 'decrypt']
    );
}

async function encryptSessionString(plaintext, pin) {
    const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_LENGTH_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH_BYTES));
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
    const salt = combined.slice(0, PBKDF2_SALT_LENGTH_BYTES);
    const iv = combined.slice(PBKDF2_SALT_LENGTH_BYTES, PBKDF2_SALT_LENGTH_BYTES + AES_GCM_IV_LENGTH_BYTES);
    const ciphertext = combined.slice(PBKDF2_SALT_LENGTH_BYTES + AES_GCM_IV_LENGTH_BYTES);
    const key = await deriveKey(pin, salt);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
}

export function getPin(promptMessage) {
    if (state.sessionPin) return state.sessionPin;
    const entered = window.prompt(promptMessage);
    if (entered) state.sessionPin = entered;
    return state.sessionPin;
}

export async function saveEncryptedSessionString(plainSessionString) {
    if (!isCryptoSupported()) {
        log('ℹ️ Your browser doesn\'t support the encryption needed to save your login — you\'ll just need to log in again if the backend restarts. Everything else works normally.', 'info');
        return;
    }
    const pin = getPin(`Set a PIN to protect your saved Telegram login on this device (${MIN_PIN_LENGTH}+ digits, remember it — it cannot be recovered):`);
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

export async function loadDecryptedSessionString(pin) {
    if (!isCryptoSupported()) return null;
    const savedEncrypted = localStorage.getItem('telegrab-mt-sessionstring');
    if (!savedEncrypted) return null;
    return decryptSessionString(savedEncrypted, pin);
}

export function hasSavedSessionString() {
    return !!localStorage.getItem('telegrab-mt-sessionstring');
}

export function clearSavedSessionString() {
    localStorage.removeItem('telegrab-mt-sessionstring');
    localStorage.removeItem('telegrab-mt-session');
}
