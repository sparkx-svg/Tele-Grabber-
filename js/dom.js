// ===== Central DOM refs =====
// Every module imports element references from here instead of calling
// document.getElementById() itself, so there's exactly one place that
// knows about index.html's structure.
export const dom = {
    fileUrlInput: document.getElementById('fileUrl'),
    grabBtn: document.getElementById('grabBtn'),
    bulkUrls: document.getElementById('bulkUrls'),
    bulkGrabBtn: document.getElementById('bulkGrabBtn'),
    dropZone: document.getElementById('dropZone'),
    progressContainer: document.getElementById('progressContainer'),
    progressFill: document.getElementById('progressFill'),
    progressPercent: document.getElementById('progressPercent'),
    progressSize: document.getElementById('progressSize'),
    progressSpeed: document.getElementById('progressSpeed'),
    statusLog: document.getElementById('statusLog'),
    hashDisplay: document.getElementById('hashDisplay'),
    hashValue: document.getElementById('hashValue'),
    copyHashBtn: document.getElementById('copyHashBtn'),
    pauseBtn: document.getElementById('pauseBtn'),
    resumeBtn: document.getElementById('resumeBtn'),
    themeToggle: document.getElementById('themeToggle'),
    settingsToggle: document.getElementById('settingsToggle'),
    settingsPanel: document.getElementById('settingsPanel'),
    pickFolderBtn: document.getElementById('pickFolderBtn'),
    resetFolderBtn: document.getElementById('resetFolderBtn'),
    folderDisplay: document.getElementById('folderDisplay'),
    nativeDownloadToggle: document.getElementById('nativeDownloadToggle'),

    // MTProto panel
    backendUrlInput: document.getElementById('backendUrl'),
    phoneInput: document.getElementById('phoneInput'),
    sendCodeBtn: document.getElementById('sendCodeBtn'),
    codeStep: document.getElementById('codeStep'),
    codeInput: document.getElementById('codeInput'),
    submitCodeBtn: document.getElementById('submitCodeBtn'),
    passwordStep: document.getElementById('passwordStep'),
    passwordInput: document.getElementById('passwordInput'),
    submitPasswordBtn: document.getElementById('submitPasswordBtn'),
    mtprotoLoggedOut: document.getElementById('mtprotoLoggedOut'),
    mtprotoLoggedIn: document.getElementById('mtprotoLoggedIn'),
    logoutBtn: document.getElementById('logoutBtn'),
    mtprotoStatus: document.getElementById('mtprotoStatus'),
};
