// ===== Shared mutable state =====
// A single plain object rather than scattered module-level `let`s, so any
// module that needs to read or flip a flag (pause/cancel/isDownloading)
// does it through one imported reference instead of its own private copy.
export const state = {
    receivedBytes: 0,
    totalBytes: 0,
    paused: false,
    startTime: 0,
    selectedFolderHandle: null,
    currentFileName: '',
    cancelDownload: false,
    isDownloading: false,

    // MTProto
    mtSessionId: localStorage.getItem('telegrab-mt-session') || null,
    mtLoggedIn: false,
    sessionPin: null, // kept in memory only for this tab's lifetime
};
