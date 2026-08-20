// ===== Pure CDN URL construction & validation =====
// Split out of cdnResolver.js: everything here is a pure function of its
// arguments (no `fetch`, no `state`, no `log`), which is what makes the
// brute-force URL list and the validation logic unit-testable without
// mocking the network or a DOM.
//
// cdn.telegram.org links are per-download, signed, and expire — they can't
// really be brute-forced (see README). These "guessed" URLs survive only as
// a last-resort fallback for people who haven't set up the MTProto backend.

import { ALLOWED_EXTENSIONS } from './fileTypes.js';

export const ALLOWED_CDN_HOST = 'cdn.telegram.org';

/** @typedef {`https://t.me/${string}/${number}`} TelegramMessageLink */

/** File extensions tried when brute-forcing a cdn.telegram.org filename. */
export const CDN_GUESS_EXTENSIONS = [
    '.zip', '.rar', '.7z', '.gz', '.bz2', '.xz', '.tar',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm',
    '.mp3', '.wav', '.flac', '.aac', '.ogg',
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg',
    '.exe', '.msi', '.apk', '.dmg', '.pkg',
    '.iso', '.img', '.bin',
    '.txt', '.log', '.csv', '.json', '.xml', '.yml', '.yaml',
    '',
];

/**
 * Filename patterns tried when brute-forcing a cdn.telegram.org filename,
 * given a channel `username` and post `postId`.
 * @param {string} username
 * @param {string} postId
 * @returns {string[]}
 */
export function cdnGuessPatterns(username, postId) {
    return [
        `${username}_${postId}_1`, `${username}_${postId}_2`, `${username}_${postId}_3`,
        `${username}_${postId}_4`, `${username}_${postId}_5`, `${username}_${postId}`,
        `${username}_${postId}_file`, `${username}_${postId}_media`, `file_${postId}`,
        `${postId}_${username}`, `${username}_${postId}_download`,
        `${username}_${postId}_archive`, `${username}_${postId}_data`,
    ];
}

/**
 * Extracts `{ username, postId }` from a `t.me/<username>/<postId>` link.
 * @param {string} link
 * @returns {{ username: string, postId: string } | null}
 */
export function parseTelegramLink(link) {
    const match = link.match(/t\.me\/([^/]+)\/(\d+)/);
    if (!match) return null;
    const [, username, postId] = match;
    return { username, postId };
}

/**
 * Strict CDN URL validation: exact hostname match, locked-down path shape,
 * extension allow-list. (The old check — startsWith('https://') &&
 * includes('telegram.org') — is trivially spoofed, e.g. by
 * "https://telegram.org.evil.com/x".)
 * @param {string} input
 * @returns {boolean}
 */
export function isValidCdnUrl(input) {
    let parsed;
    try {
        parsed = new URL(input);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname !== ALLOWED_CDN_HOST) return false;
    const match = parsed.pathname.match(/^\/file\/([A-Za-z0-9._-]+)$/);
    if (!match) return false;
    const filename = match[1];
    if (filename.includes('..')) return false;
    const dotIndex = filename.lastIndexOf('.');
    if (dotIndex !== -1) {
        // Has an extension — it must be one we recognize.
        const ext = filename.slice(dotIndex + 1).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(ext)) return false;
    }
    // No extension at all is allowed: Telegram's CDN does serve some files
    // without one, and the brute-force guess list below deliberately
    // includes extension-less filename guesses.
    return true;
}

/**
 * A short, curated list of the most-likely CDN URL guesses for a t.me link
 * — used to populate the manual "Suggest" field, as opposed to
 * {@link buildCdnGuessUrls}'s exhaustive brute-force list.
 * @param {string} input
 * @returns {string[]}
 */
export function suggestCdnUrls(input) {
    const parsed = parseTelegramLink(input);
    if (!parsed) return [];
    const { username, postId } = parsed;
    return [
        `https://cdn.telegram.org/file/${username}_${postId}_1.zip`,
        `https://cdn.telegram.org/file/${username}_${postId}.zip`,
        `https://cdn.telegram.org/file/${username}_${postId}_1.rar`,
        `https://cdn.telegram.org/file/${username}_${postId}_1.7z`,
        `https://cdn.telegram.org/file/${username}_${postId}_1.pdf`,
        `https://cdn.telegram.org/file/${username}_${postId}_1.mp4`,
    ];
}

/**
 * The full (deduplicated) cross-product of {@link cdnGuessPatterns} x
 * {@link CDN_GUESS_EXTENSIONS} for a t.me link, used by the brute-force
 * resolver.
 * @param {string} link
 * @returns {string[]}
 */
export function buildCdnGuessUrls(link) {
    const parsed = parseTelegramLink(link);
    if (!parsed) return [];
    const { username, postId } = parsed;

    const patterns = cdnGuessPatterns(username, postId);
    const urls = [];
    for (const pattern of patterns) {
        for (const ext of CDN_GUESS_EXTENSIONS) {
            urls.push(`https://${ALLOWED_CDN_HOST}/file/${pattern}${ext}`);
        }
    }
    return [...new Set(urls)];
}
