// ===== File type detection (pure, no DOM dependency) =====
// Split out of ui.js so this logic — and the extension allow-list derived
// from it, which cdnUrlUtils.js relies on for CDN URL validation — can be
// unit-tested without needing a browser/DOM environment.

/** @type {Record<string, string>} */
export const FILE_TYPES = {
    zip: '📦 ZIP Archive', rar: '📦 RAR Archive', '7z': '📦 7-Zip Archive', gz: '📦 GZ Archive',
    bz2: '📦 BZ2 Archive', xz: '📦 XZ Archive', tar: '📦 TAR Archive',
    pdf: '📄 PDF Document', doc: '📄 Word Document', docx: '📄 Word Document',
    xls: '📊 Excel Spreadsheet', xlsx: '📊 Excel Spreadsheet',
    ppt: '📽️ PowerPoint', pptx: '📽️ PowerPoint',
    mp4: '🎬 MP4 Video', mkv: '🎬 MKV Video', avi: '🎬 AVI Video', mov: '🎬 MOV Video',
    wmv: '🎬 WMV Video', flv: '🎬 FLV Video', webm: '🎬 WebM Video',
    mp3: '🎵 MP3 Audio', wav: '🎵 WAV Audio', flac: '🎵 FLAC Audio', aac: '🎵 AAC Audio', ogg: '🎵 OGG Audio',
    jpg: '🖼️ JPEG Image', jpeg: '🖼️ JPEG Image', png: '🖼️ PNG Image', gif: '🖼️ GIF Image',
    bmp: '🖼️ BMP Image', webp: '🖼️ WebP Image', svg: '🖼️ SVG Image',
    exe: '⚙️ Windows Executable', msi: '⚙️ Windows Installer', apk: '📱 Android APK',
    dmg: '💻 Mac DMG', pkg: '💻 Mac PKG',
    iso: '💿 ISO Disk Image', img: '💿 IMG Disk Image', bin: '💿 BIN Disk Image',
    txt: '📝 Text File', log: '📝 Log File',
    csv: '📊 CSV Data', json: '📊 JSON Data', xml: '📊 XML Data', yml: '📊 YAML Data', yaml: '📊 YAML Data',
};

export const ALLOWED_EXTENSIONS = new Set(Object.keys(FILE_TYPES));

/**
 * @param {string} url
 * @returns {string} A human-readable "icon + label" description of the
 *   file type implied by the URL's extension, or a generic fallback for
 *   unrecognized/missing extensions.
 */
export function getFileType(url) {
    // Extract just the last path segment (the filename) before looking for
    // an extension — splitting the *whole* URL on '.' is wrong whenever the
    // hostname itself contains a dot (e.g. "cdn.telegram.org") and the
    // filename has no extension: it would grab "org/file/thing" instead of
    // recognizing there's no extension at all.
    let filename;
    try {
        filename = new URL(url).pathname.split('/').pop() || '';
    } catch {
        // Not a full URL (e.g. a bare filename) — fall back to using the
        // whole string as the "path".
        filename = url.split('/').pop() || '';
    }
    const dotIndex = filename.lastIndexOf('.');
    const ext = dotIndex === -1 ? '' : filename.slice(dotIndex + 1).toLowerCase();
    return FILE_TYPES[ext] || `📁 File (${ext.toUpperCase() || 'unknown'})`;
}
