// What's new: the changelog as data, which versions are new to somebody, and the dialog.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    parseChangelog, compareVersions, versionsBetween, recentVersions, whatsNewDecision, whatsNewView,
    inline, MAX_VERSIONS,
} from '../src/updates/changelog.js';

const real = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const SAMPLE = `# Changelog

Intro text that belongs to no version.

## [Unreleased]

### Added
- **Not out yet.** Nobody is running this.

## [1.2.0] - 2026-10-20

### Added
- **A thing.** It does this,
  and continues here.

  A second paragraph of the same item.
- \`code\` in an item.

### Fixed
- **Another.** Fixed.

## [1.1.9] - 2026-10-01

### Fixed
- Older.
`;

test('the release being built has notes — a release cannot ship without them', () => {
    // The app shows these after it updates. A version with no entry would open What's New
    // on nothing, or worse, on the previous version's notes as if they were this one's.
    const versions = parseChangelog(real).map((v) => v.version);
    assert.ok(versions.includes(pkg.version),
        `CHANGELOG.md has no "## [${pkg.version}]" entry — rename [Unreleased] when bumping the version`);
});

test('every released version in the real changelog parses into something to show', () => {
    const released = parseChangelog(real).filter((v) => /^\d+\.\d+\.\d+$/.test(v.version));
    assert.ok(released.length > 10);
    for (const v of released.slice(0, 10)) {
        const items = v.sections.flatMap((s) => s.items);
        assert.ok(items.length, `${v.version} parsed with no items`);
        for (const item of items) assert.ok(item.paragraphs.every(Boolean), `${v.version} has an empty paragraph`);
    }
});

test('versions, sections, items and paragraphs come out as written', () => {
    const [unreleased, current, older] = parseChangelog(SAMPLE);
    assert.equal(unreleased.version, 'Unreleased');
    assert.equal(current.version, '1.2.0');
    assert.equal(current.date, '2026-10-20');
    assert.deepEqual(current.sections.map((s) => s.heading), ['Added', 'Fixed']);
    const [first, second] = current.sections[0].items;
    assert.deepEqual(first.paragraphs, [
        '**A thing.** It does this, and continues here.',
        'A second paragraph of the same item.',
    ]);
    assert.deepEqual(second.paragraphs, ['`code` in an item.']);
    assert.equal(older.sections[0].items[0].paragraphs[0], 'Older.');
});

test('versions compare as numbers, not as text', () => {
    assert.ok(compareVersions('0.1.10', '0.1.9') > 0, '10 is after 9');
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
    assert.ok(compareVersions('Unreleased', '0.0.1') < 0, 'a heading that is not a version sorts last');
});

test('an update shows every version since the one last seen, newest first, never Unreleased', () => {
    const versions = parseChangelog(SAMPLE);
    assert.deepEqual(versionsBetween(versions, '1.1.8', '1.2.0').map((v) => v.version), ['1.2.0', '1.1.9']);
    assert.deepEqual(versionsBetween(versions, '1.1.9', '1.2.0').map((v) => v.version), ['1.2.0']);
    assert.deepEqual(versionsBetween(versions, '1.2.0', '1.2.0'), [], 'nothing new, nothing shown');
});

test('a long-unopened app shows a handful, not a wall', () => {
    const versions = parseChangelog(real);
    assert.ok(versionsBetween(versions, '0.0.1', pkg.version).length <= MAX_VERSIONS);
});

test('on request it shows this version and a couple before it', () => {
    const versions = parseChangelog(SAMPLE);
    assert.deepEqual(recentVersions(versions, '1.2.0', 2).map((v) => v.version), ['1.2.0', '1.1.9']);
});

test('a first run remembers the version and shows nothing; an update shows once', () => {
    assert.deepEqual(whatsNewDecision({ lastSeen: null, current: '1.2.0' }), { show: false, remember: '1.2.0' });
    assert.deepEqual(whatsNewDecision({ lastSeen: '1.1.9', current: '1.2.0' }), { show: true, remember: '1.2.0' });
    assert.deepEqual(whatsNewDecision({ lastSeen: '1.2.0', current: '1.2.0' }), { show: false, remember: '1.2.0' });
    // A downgrade is not news.
    assert.equal(whatsNewDecision({ lastSeen: '1.3.0', current: '1.2.0' }).show, false);
    // A development build has no real version to compare.
    assert.equal(whatsNewDecision({ lastSeen: '1.0.0', current: '0.0.0-dev' }).show, false);
});

test('the notes are escaped before any markup is added', () => {
    assert.equal(inline('**bold** and `x<y`'), '<strong>bold</strong> and <code>x&lt;y</code>');
    assert.equal(inline('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(inline('[a link](https://example.com)'), 'a link', 'links are not followed from here');
});

test('the dialog lists each version with its sections and a way out', () => {
    const markup = whatsNewView(parseChangelog(SAMPLE).slice(1, 2), { current: '1.2.0' });
    assert.match(markup, /What's new in Weave 1\.2\.0/);
    assert.match(markup, /<strong>A thing\.<\/strong>/);
    assert.match(markup, /whats-new-kind">Fixed/);
    assert.match(markup, /data-whats-new-close/);
    assert.match(whatsNewView([]), /no notes/);
});
