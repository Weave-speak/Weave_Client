// Link recognition: the pure half of rich chat. Every provider has three URL shapes and
// someone always pastes the fourth — these are the shapes we promise to catch, and the
// shapes we promise to REFUSE (nothing embeds that is not a known player).

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUrls, parseProviderUrl, embedFor } from '../src/room/embeds.js';

test('urls are found, deduplicated, and stripped of trailing punctuation', () => {
    assert.deepEqual(
        extractUrls('see https://a.example/x, and (https://b.example/y) or https://a.example/x!'),
        ['https://a.example/x', 'https://b.example/y']);
    assert.deepEqual(extractUrls('no links here'), []);
});

test('youtube in all its spellings', () => {
    for (const url of [
        'https://youtu.be/dQw4w9WgXcQ',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=xyz',
        'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    ]) {
        const e = parseProviderUrl(url);
        assert.equal(e?.provider, 'youtube', url);
        assert.match(e.embedUrl, /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
    }
    const timed = parseProviderUrl('https://youtu.be/dQw4w9WgXcQ?t=42');
    assert.match(timed.embedUrl, /start=42/);
});

test('x, instagram and tiktok resolve to their official embed surfaces', () => {
    assert.match(parseProviderUrl('https://x.com/someone/status/1790000000000000000').embedUrl,
        /platform\.twitter\.com\/embed\/Tweet\.html\?id=1790000000000000000/);
    assert.match(parseProviderUrl('https://twitter.com/someone/status/1790000000000000000').embedUrl,
        /id=1790000000000000000/);
    assert.match(parseProviderUrl('https://www.instagram.com/reel/Cabc123XYZ_/').embedUrl,
        /instagram\.com\/p\/Cabc123XYZ_\/embed/);
    assert.match(parseProviderUrl('https://www.tiktok.com/@someone/video/7300000000000000000').embedUrl,
        /tiktok\.com\/embed\/v2\/7300000000000000000/);
});

test('what is not a player never becomes an iframe', () => {
    for (const url of [
        'https://example.com/watch?v=abc',
        'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
        'https://x.com/someone',
        'https://instagram.com/someone',
        'https://tiktok.com/@someone',
        'javascript:alert(1)',
        'not a url',
    ]) {
        assert.equal(parseProviderUrl(url), null, url);
    }
});

test('embedFor picks the first embeddable link and carries its source url', () => {
    const e = embedFor('look https://example.com/x then https://youtu.be/dQw4w9WgXcQ done');
    assert.equal(e.provider, 'youtube');
    assert.equal(e.url, 'https://youtu.be/dQw4w9WgXcQ');
    assert.equal(embedFor('nothing to see'), null);
});
