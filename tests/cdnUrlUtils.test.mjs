// ===== Unit tests: CDN URL construction & validation =====
// These target js/cdnUrlUtils.js, which was deliberately extracted from
// cdnResolver.js to have zero DOM/network dependencies — so these tests run
// as plain Node ESM, no browser or fetch mocking required.
//
// Run with: npm test  (or: node --test tests/)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    isValidCdnUrl,
    parseTelegramLink,
    suggestCdnUrls,
    buildCdnGuessUrls,
    cdnGuessPatterns,
    CDN_GUESS_EXTENSIONS,
    ALLOWED_CDN_HOST,
} from '../js/cdnUrlUtils.js';

describe('isValidCdnUrl', () => {
    test('accepts a well-formed cdn.telegram.org file URL', () => {
        assert.equal(isValidCdnUrl('https://cdn.telegram.org/file/somefile_123_1.zip'), true);
    });

    test('accepts a URL with no extension (guess list includes one)', () => {
        assert.equal(isValidCdnUrl('https://cdn.telegram.org/file/somefile_123'), true);
    });

    test('rejects non-https protocols', () => {
        assert.equal(isValidCdnUrl('http://cdn.telegram.org/file/x.zip'), false);
    });

    test('rejects a spoofed hostname that merely contains "telegram.org"', () => {
        // The old validation (startsWith('https://') && includes('telegram.org'))
        // let this through — this is the regression test for that bug.
        assert.equal(isValidCdnUrl('https://telegram.org.evil.com/file/x.zip'), false);
        assert.equal(isValidCdnUrl('https://evil.com/?x=https://cdn.telegram.org/file/x.zip'), false);
    });

    test('rejects a disallowed extension', () => {
        assert.equal(isValidCdnUrl('https://cdn.telegram.org/file/x.exe.sh'), false);
    });

    test('rejects path traversal attempts', () => {
        assert.equal(isValidCdnUrl('https://cdn.telegram.org/file/..%2F..%2Fetc%2Fpasswd'), false);
    });

    test('rejects a URL with an unexpected path shape', () => {
        assert.equal(isValidCdnUrl('https://cdn.telegram.org/file/sub/x.zip'), false);
        assert.equal(isValidCdnUrl('https://cdn.telegram.org/other/x.zip'), false);
    });

    test('rejects garbage input without throwing', () => {
        assert.equal(isValidCdnUrl('not a url'), false);
        assert.equal(isValidCdnUrl(''), false);
    });
});

describe('parseTelegramLink', () => {
    test('extracts username and postId from a standard link', () => {
        assert.deepEqual(parseTelegramLink('https://t.me/somechannel/482'), { username: 'somechannel', postId: '482' });
    });

    test('returns null for a non-matching link', () => {
        assert.equal(parseTelegramLink('https://example.com/nope'), null);
    });
});

describe('suggestCdnUrls', () => {
    test('returns a short curated list for a valid link', () => {
        const suggestions = suggestCdnUrls('https://t.me/somechannel/482');
        assert.ok(suggestions.length > 0);
        assert.ok(suggestions.every((u) => u.startsWith(`https://${ALLOWED_CDN_HOST}/file/`)));
        assert.ok(suggestions.every(isValidCdnUrl));
    });

    test('returns an empty list for an unparseable link', () => {
        assert.deepEqual(suggestCdnUrls('not a telegram link'), []);
    });
});

describe('cdnGuessPatterns', () => {
    test('produces the expected set of filename guesses', () => {
        const patterns = cdnGuessPatterns('chan', '99');
        assert.ok(patterns.includes('chan_99'));
        assert.ok(patterns.includes('chan_99_1'));
        assert.ok(patterns.includes('file_99'));
        assert.ok(patterns.includes('99_chan'));
    });
});

describe('buildCdnGuessUrls', () => {
    test('produces a deduplicated cross-product of patterns x extensions', () => {
        const urls = buildCdnGuessUrls('https://t.me/somechannel/482');
        const patterns = cdnGuessPatterns('somechannel', '482');

        // Cross product size, minus duplicates introduced by the trailing
        // "no extension" entry overlapping with an already-bare pattern.
        assert.ok(urls.length > 0);
        assert.ok(urls.length <= patterns.length * CDN_GUESS_EXTENSIONS.length);

        // No duplicates.
        assert.equal(new Set(urls).size, urls.length);

        // Every generated URL should itself be a valid CDN URL shape.
        for (const url of urls) {
            assert.equal(isValidCdnUrl(url), true, `expected ${url} to be a valid CDN URL`);
        }
    });

    test('returns an empty list for a link with no message id', () => {
        assert.deepEqual(buildCdnGuessUrls('https://t.me/somechannel'), []);
    });
});
