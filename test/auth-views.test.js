// The authentication screens.
//
// The first test here exists because of a bug that took a while to explain and one second
// to cause: pressing Enter on the sign-in form opened the server settings instead of
// signing in. A `<button>` with no `type` attribute defaults to `type="submit"`, and the
// gear icon sat above the Sign In button in the same form — so Enter fired the first
// submit-capable control it found, which was the gear.
//
// Nothing about that is visible when reading the markup, which is why it is a test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir = SRC, found = []) {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) sourceFiles(path, found);
        else if (name.endsWith('.js')) found.push(path);
    }
    return found;
}

/** Every `<button` tag in a source file, with the line it is on. */
function buttonTags(text) {
    return [...text.matchAll(/<button\b[^>]*>/g)].map((match) => ({
        tag: match[0],
        line: text.slice(0, match.index).split('\n').length,
    }));
}

test('every button declares its type', () => {
    // The default is "submit". Inside a form that makes any unlabelled button a second
    // submit control, and the FIRST one in the DOM is what Enter activates — which is how a
    // decorative icon ends up hijacking the sign-in key.
    const offences = [];

    for (const file of sourceFiles()) {
        for (const { tag, line } of buttonTags(readFileSync(file, 'utf8'))) {
            if (!/\btype\s*=/.test(tag)) {
                offences.push(`${relative(SRC, file)}:${line}  ${tag.replace(/\s+/g, ' ').slice(0, 70)}`);
            }
        }
    }

    assert.deepEqual(offences, [],
        'A button with no type defaults to submit. Say type="button" unless it really submits.');
});

test('the guard catches the shape of the bug that shipped', () => {
    // The exact gear markup, before the fix.
    const bad = '<button class="icon-btn card-gear" data-open-servers\n        title="Servers">';
    assert.equal(buttonTags(bad).filter((b) => !/\btype\s*=/.test(b.tag)).length, 1);

    const good = '<button type="button" class="icon-btn card-gear" data-open-servers>';
    assert.equal(buttonTags(good).filter((b) => !/\btype\s*=/.test(b.tag)).length, 0);
});

test('exactly one submit button per form, and it is the real action', async () => {
    // Even with types declared, two submit buttons in one form means Enter picks the first
    // one — which may not be the one the person is looking at.
    const views = await import('../src/auth/views.js');

    for (const [name, markup] of [
        ['signIn', views.signIn()],
        ['register', views.register({ questions: [] })],
        ['forgotUsername', views.forgotUsername()],
        ['servers', views.servers({ firstRun: true })],
    ]) {
        const submits = buttonTags(markup).filter((b) => /type\s*=\s*"submit"/.test(b.tag));
        assert.equal(submits.length, 1, `${name} should have exactly one submit button`);
    }
});

test('the Remember me box appears only where there is somewhere safe to put a password', async () => {
    // A browser already has a password manager, and it is better than anything we would
    // write. Offering a second, worse one would be actively unhelpful — so in the browser
    // build the box is absent rather than present and broken.
    const views = await import('../src/auth/views.js');
    const { platform } = await import('../src/platform/index.js');

    assert.equal(platform.credentials.available, false, 'no credential store in a browser');
    assert.ok(!views.signIn().includes('name="remember"'));
});

test('the browser credential store is inert rather than absent', async () => {
    // Callers must be able to ask without checking first; a capability that throws when it
    // is missing turns "not supported here" into an error the user has to see.
    const { platform } = await import('../src/platform/index.js');
    assert.equal(await platform.credentials.get('any-server'), null);
    assert.equal(await platform.credentials.set('any-server', 'u', 'p'), false);
    assert.equal(await platform.credentials.clear('any-server'), false);
});

test('the forced-reset card says who, why, and what to do', async () => {
    const views = await import('../src/auth/views.js');
    const markup = views.chooseNewPassword({ username: 'kestrel', instanceName: 'Weave' });
    assert.match(markup, /id="resetRequiredForm"/);
    assert.match(markup, /administrator of Weave reset the password/);
    assert.match(markup, /kestrel/);
    assert.match(markup, /autocomplete="new-password"/);
    assert.match(markup, /old password\s+no longer opens anything/, 'states the consequence plainly');
});

test('a hostile username cannot become markup on the forced-reset card', async () => {
    const views = await import('../src/auth/views.js');
    const markup = views.chooseNewPassword({ username: '<img src=x onerror=steal()>' });
    assert.ok(!markup.includes('<img src=x'));
    assert.match(markup, /&lt;img/);
});
