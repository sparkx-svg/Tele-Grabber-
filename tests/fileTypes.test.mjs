// ===== Unit tests: file type detection =====
// Targets js/fileTypes.js, extracted from ui.js specifically so it has no
// DOM dependency and can be tested as plain Node ESM.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getFileType, ALLOWED_EXTENSIONS, FILE_TYPES } from '../js/fileTypes.js';

describe('getFileType', () => {
    test('recognizes a known extension', () => {
        assert.equal(getFileType('https://cdn.telegram.org/file/movie.mp4'), FILE_TYPES.mp4);
    });

    test('is case-insensitive on extension', () => {
        assert.equal(getFileType('https://cdn.telegram.org/file/movie.MP4'), FILE_TYPES.mp4);
    });

    test('falls back to a generic label for an unknown extension', () => {
        assert.equal(getFileType('https://cdn.telegram.org/file/thing.xyz'), '📁 File (XYZ)');
    });

    test('handles a URL with no extension at all', () => {
        assert.equal(getFileType('https://cdn.telegram.org/file/thing'), '📁 File (unknown)');
    });
});

describe('ALLOWED_EXTENSIONS', () => {
    test('is derived from FILE_TYPES and stays in sync with it', () => {
        assert.equal(ALLOWED_EXTENSIONS.size, Object.keys(FILE_TYPES).length);
        for (const ext of Object.keys(FILE_TYPES)) {
            assert.ok(ALLOWED_EXTENSIONS.has(ext));
        }
    });

    test('does not include an arbitrary disallowed extension', () => {
        assert.equal(ALLOWED_EXTENSIONS.has('sh'), false);
        assert.equal(ALLOWED_EXTENSIONS.has('php'), false);
    });
});
