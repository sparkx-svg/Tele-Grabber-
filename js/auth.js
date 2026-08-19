import { dom } from './dom.js';
import { state } from './state.js';
import { log } from './ui.js';
import {
    getPin,
    saveEncryptedSessionString,
    loadDecryptedSessionString,
    hasSavedSessionString,
    clearSavedSessionString,
    isCryptoSupported,
} from './storage.js';

export function mtBackend() {
    return (dom.backendUrlInput.value || '').trim().replace(/\/+$/, '');
}

function setMtStatus(msg) {
    dom.mtprotoStatus.textContent = msg || '';
}

function showLoggedIn(isIn) {
    state.mtLoggedIn = isIn;
    dom.mtprotoLoggedIn.classList.toggle('hidden', !isIn);
    dom.mtprotoLoggedOut.classList.toggle('hidden', isIn);
}

export function restoreBackendUrl() {
    const savedBackend = localStorage.getItem('telegrab-backend-url');
    if (savedBackend) dom.backendUrlInput.value = savedBackend;
}

// ===== Resume a previous login on page load =====
export async function checkMtStatus() {
    const backend = mtBackend();
    if (!backend) return;

    // First try the normal (in-memory) session, in case the backend hasn't restarted.
    if (state.mtSessionId) {
        try {
            const res = await fetch(`${backend}/auth/status?sessionId=${state.mtSessionId}`);
            const data = await res.json();
            if (data.loggedIn) {
                showLoggedIn(true);
                log('🔐 MTProto session restored — logged in.', 'done');
                return;
            }
        } catch {
            // backend unreachable; fall through to try resume
        }
    }

    // Backend forgot us (likely redeployed) — try resuming with the saved
    // session string instead, which logs back in without needing the code again.
    if (!hasSavedSessionString()) return;

    if (!isCryptoSupported()) {
        // A saved session string exists (saved in a different, crypto-capable
        // context) but this browser/context can't decrypt it. Don't prompt
        // for a PIN just to fail — clear the now-unusable saved session and
        // let the user log in normally instead.
        clearSavedSessionString();
        log('ℹ️ Saved login can\'t be restored in this browser (missing crypto support) — please log in again.', 'info');
        return;
    }

    const pin = getPin('Enter your PIN to resume your saved Telegram login:');
    if (!pin) return; // user cancelled — stay logged out, no harm done

    let savedSessionString;
    try {
        savedSessionString = await loadDecryptedSessionString(pin);
    } catch {
        log('❌ Wrong PIN — could not unlock saved login. Please log in again.', 'error');
        state.sessionPin = null;
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
            state.mtSessionId = data.sessionId;
            localStorage.setItem('telegrab-mt-session', state.mtSessionId);
            showLoggedIn(true);
            setMtStatus('');
            log('🔐 Logged back in automatically (session resumed).', 'done');
            return;
        }
        // Saved session no longer valid — clear it so we don't keep retrying.
        clearSavedSessionString();
        setMtStatus('');
    } catch {
        setMtStatus('');
    }
}

async function sendCode() {
    const backend = mtBackend();
    const phone = dom.phoneInput.value.trim();
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
        state.mtSessionId = data.sessionId;
        localStorage.setItem('telegrab-mt-session', state.mtSessionId);
        dom.codeStep.classList.remove('hidden');
        setMtStatus('Code sent — check Telegram on your other device.');
        log('📩 Login code requested. Check your Telegram app.', 'info');
    } catch (err) {
        setMtStatus('');
        log(`❌ Send code failed: ${err.message}`, 'error');
    }
}

async function submitCode() {
    const backend = mtBackend();
    const code = dom.codeInput.value.trim();
    if (!code) { log('⚠️ Enter the code you received.', 'warn'); return; }
    setMtStatus('Verifying…');
    try {
        const res = await fetch(`${backend}/auth/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: state.mtSessionId, field: 'code', value: code }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Verification failed');
        if (data.status === 'logged_in') {
            if (data.sessionString) await saveEncryptedSessionString(data.sessionString);
            showLoggedIn(true);
            setMtStatus('');
            log('✅ MTProto login successful.', 'done');
        } else if (data.needs === 'password') {
            dom.passwordStep.classList.remove('hidden');
            setMtStatus('2FA enabled — enter your Telegram password.');
        }
    } catch (err) {
        setMtStatus('');
        log(`❌ Code verification failed: ${err.message}`, 'error');
    }
}

async function submitPassword() {
    const backend = mtBackend();
    const password = dom.passwordInput.value;
    if (!password) { log('⚠️ Enter your 2FA password.', 'warn'); return; }
    setMtStatus('Verifying password…');
    try {
        const res = await fetch(`${backend}/auth/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: state.mtSessionId, field: 'password', value: password }),
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
}

async function logout() {
    const backend = mtBackend();
    try {
        await fetch(`${backend}/auth/logout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: state.mtSessionId }),
        });
    } catch {
        // best-effort — clear local state regardless of whether this succeeded
    }
    clearSavedSessionString();
    state.mtSessionId = null;
    state.sessionPin = null;
    showLoggedIn(false);
    dom.codeStep.classList.add('hidden');
    dom.passwordStep.classList.add('hidden');
    dom.codeInput.value = '';
    dom.passwordInput.value = '';
    log('👋 Logged out of MTProto.', 'info');
}

export function initAuth() {
    restoreBackendUrl();
    dom.backendUrlInput.addEventListener('change', () => {
        localStorage.setItem('telegrab-backend-url', dom.backendUrlInput.value.trim());
    });
    dom.sendCodeBtn.addEventListener('click', sendCode);
    dom.submitCodeBtn.addEventListener('click', submitCode);
    dom.submitPasswordBtn.addEventListener('click', submitPassword);
    dom.logoutBtn.addEventListener('click', logout);
    // Fire-and-forget: checkMtStatus() already handles its own expected
    // failure paths internally, but nothing guarantees a future edit won't
    // introduce an uncaught rejection here — this keeps that from becoming
    // an unhandled promise rejection at startup.
    checkMtStatus().catch((err) => {
        log(`⚠️ Could not check MTProto login status: ${err.message}`, 'warn');
    });
}
