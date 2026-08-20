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
