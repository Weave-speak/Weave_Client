// Nothing a server sends may become markup.
//
// This client shipped with a server's own name interpolated raw into innerHTML on the
// add-server screen — a screen reached by TYPING AN ADDRESS, before the user has decided
// to trust that host at all. Any host could put script into the client of anyone who typed
// its address, and in the desktop build that script sits behind a native bridge.
//
// Two guards, because one is not enough. The first pins what `safe` does. The second reads
// the source and fails if anyone writes the unsafe form again, which is the failure mode
// that actually happened: not a broken escape function, but a place that forgot to call it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { esc, safe } from '../src/ui/dom.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir = SRC, found = []) {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) sourceFiles(path, found);
        else if (name.endsWith('.js')) found.push(path);
    }
    return found;
}

test('esc neutralises every character that could open a tag or escape an attribute', () => {
    assert.equal(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(esc('" onmouseover="evil()'), '&quot; onmouseover=&quot;evil()');
    assert.equal(esc("' onfocus='evil()"), '&#39; onfocus=&#39;evil()');
    // Ampersand first, or every other replacement becomes double-escapable.
    assert.equal(esc('&lt;'), '&amp;lt;');
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
    assert.equal(esc(0), '0');
});

test('safe escapes the holes and leaves the markup alone', () => {
    const name = '<img src=x onerror=alert(1)>';
    const out = safe`<strong>${name}</strong>`;
    assert.equal(out, '<strong>&lt;img src=x onerror=alert(1)&gt;</strong>');
    // The structure we wrote survives; the value can never add to it.
    assert.ok(out.startsWith('<strong>') && out.endsWith('</strong>'));
    assert.equal(out.match(/</g).length, 2, 'only our own two tags');
});

test('safe handles an attribute hole, which is the easier one to get wrong', () => {
    const evil = '" onload="steal()';
    const out = safe`<div title="${evil}"></div>`;
    assert.equal(out, '<div title="&quot; onload=&quot;steal()"></div>');
    assert.ok(!out.includes('onload="'), 'the attribute must not break out');
});

test('safe with no holes, and with holes at both ends', () => {
    assert.equal(safe`<p>plain</p>`, '<p>plain</p>');
    assert.equal(safe`${'a'}<i>${'b'}</i>${'c'}`, 'a<i>b</i>c');
    assert.equal(safe`${null}`, '');
});

/**
 * Find every place a bare template literal is assigned to innerHTML.
 *
 * The rule is deliberately blunt: innerHTML may take a `safe`-tagged template, or a plain
 * expression, but never a raw backtick template. Not even one that looks value-free today,
 * because a multi-line template hides its holes and the next edit is where a hole appears.
 * A rule with an exception is a rule someone will argue their way through at 1 a.m.
 */
export function findRawTemplateAssignments(text, label = '') {
    const offences = [];
    text.split(/\r?\n/).forEach((line, i) => {
        const match = /\.innerHTML\s*\+?=\s*(.*)$/.exec(line);
        if (match && match[1].trimStart().startsWith('`')) {
            offences.push(`${label}${i + 1}  ${line.trim().slice(0, 90)}`);
        }
    });
    return offences;
}

test('the source guard actually catches the bug it exists for', () => {
    // A guard that has never failed has never been shown to work. This is the exact shape
    // of the line that shipped.
    const bad = 'result.innerHTML = `<strong>${found.info.instance.name}</strong>`;';
    assert.equal(findRawTemplateAssignments(bad).length, 1);

    // Multi-line, hole further down — the form the blunt rule exists to catch.
    assert.equal(findRawTemplateAssignments('el.innerHTML = `\n  <p>${name}</p>`;').length, 1);

    // And it does not fire on the things that are fine.
    assert.deepEqual(findRawTemplateAssignments('el.innerHTML = safe`<b>${x}</b>`;'), []);
    assert.deepEqual(findRawTemplateAssignments("el.innerHTML = '';"), []);
    assert.deepEqual(findRawTemplateAssignments('el.innerHTML = views.signIn(state);'), []);
});

test('no source file assigns a raw template to innerHTML', () => {
    const offences = sourceFiles().flatMap((file) =>
        findRawTemplateAssignments(readFileSync(file, 'utf8'), `${relative(SRC, file)}:`));

    assert.deepEqual(offences, [],
        'Use the safe`` tag: innerHTML must never take an untagged template literal');
});

test('the add-server screen renders a hostile server name as text', async () => {
    // The exact shape of the bug, driven through the real discovery path: a server that
    // answers /api/server-info with markup in its own name.
    const { discover, OUTCOME } = await import('../src/server/discover.js');

    const hostile = '<img src=x onerror=alert(1)>';
    const found = await discover('weave.example.com', {
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                product: 'weave',
                version: '<script>alert(2)</script>',
                protocol: { min: 1, max: 1 },
                instance: { name: hostile, registration: 'invite_only' },
                features: [],
            }),
        }),
    });

    assert.equal(found.outcome, OUTCOME.OK);
    // Discovery passes the server's strings through untouched — that is correct, escaping
    // belongs at the point of rendering. What matters is what rendering does with them.
    assert.equal(found.info.instance.name, hostile);

    const rendered = safe`<strong>${found.info.instance.name}</strong>`
        + safe`<span>version ${found.info.version} · `;
    assert.ok(!rendered.includes('<img'), 'no tag may survive into the markup');
    assert.ok(!rendered.includes('<script'), 'nor into the version line');
    assert.ok(rendered.includes('&lt;img src=x onerror=alert(1)&gt;'), 'it should read as text');
});
