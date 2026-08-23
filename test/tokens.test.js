// The design system, enforced.
//
// A token layer that is merely documented decays: someone drops a hex code in at 1 a.m. and
// nothing objects, and a year later there are four slightly different greys and no way to
// change the accent colour. These tests are what make the rule in tokens.css real.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../src/styles', import.meta.url));

const read = (name) => readFileSync(join(DIR, name), 'utf8');
const files = readdirSync(DIR).filter((f) => f.endsWith('.css'));
const components = files.filter((f) => f !== 'tokens.css');

/** Strip comments so prose about a rule is never mistaken for the rule. */
const code = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('every layer exists and is imported exactly once, in dependency order', () => {
    const entry = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
    const order = [...entry.matchAll(/@import\s+"\.\/styles\/([\w-]+\.css)"/g)].map((m) => m[1]);
    assert.deepEqual(order, ['tokens.css', 'base.css', 'auth.css', 'shell.css'],
        'tokens must load first; nothing can use a variable defined after it');
    for (const f of files) assert.ok(order.includes(f), `${f} exists but is never imported`);
});

test('no colour literal outside tokens.css', () => {
    for (const file of components) {
        const hex = code(read(file)).match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
        assert.deepEqual(hex, [], `${file} contains a raw colour — add a token instead`);

        // A bare rgb()/hsl() with numbers is the same offence wearing a different hat.
        // rgb(var(--x) / 0.2) is the sanctioned form and passes.
        const fn = code(read(file)).match(/\b(?:rgba?|hsla?)\(\s*\d/g) ?? [];
        assert.deepEqual(fn, [], `${file} contains a raw colour function — derive it from a token`);
    }
});

test('no raw z-index outside the ladder', () => {
    for (const file of components) {
        const bad = [...code(read(file)).matchAll(/z-index:\s*([^;]+);/g)]
            .map((m) => m[1].trim())
            .filter((v) => !v.startsWith('var(--z-'));
        assert.deepEqual(bad, [], `${file} sets a z-index that is not a named rung`);
    }
});

test('only base.css may suppress the focus outline', () => {
    // The failure this prevents actually happened: `.composer-input:focus { outline: none }`
    // out-specifies the global :focus-visible rule, so the ring silently disappeared for
    // keyboard users while every automated check still passed.
    for (const file of components.filter((f) => f !== 'base.css')) {
        const bad = code(read(file)).match(/outline(?:-style)?:\s*none/g) ?? [];
        assert.deepEqual(bad, [], `${file} removes a focus outline; move the styling to the wrapper`);
    }

    const base = code(read('base.css'));
    assert.match(base, /:focus\s*\{\s*outline:\s*none/, 'base must clear the default ring');
    assert.match(base, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-line\)/,
        'and put a token-driven one back for keyboard use');
});

test('the ladder is ordered, so a rung is never above the one that should cover it', () => {
    const tokens = read('tokens.css');
    const rungs = ['--z-base', '--z-raised', '--z-sticky', '--z-popover', '--z-menu', '--z-modal', '--z-toast', '--z-drag'];
    const values = rungs.map((name) => {
        const m = new RegExp(`${name}:\\s*(-?\\d+)`).exec(tokens);
        assert.ok(m, `${name} is missing from the ladder`);
        return Number(m[1]);
    });
    for (let i = 1; i < values.length; i++) {
        assert.ok(values[i] > values[i - 1], `${rungs[i]} must sit above ${rungs[i - 1]}`);
    }
    assert.ok(Number(/--z-below:\s*(-?\d+)/.exec(tokens)[1]) < 0, 'the background belongs behind everything');
});

test('every token a component references is actually defined', () => {
    // A typo in a var() name is silent: the property just does not apply, and the element
    // renders with whatever it inherited. This is the only thing that catches it.
    const defined = new Set([...read('tokens.css').matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
    const missing = new Set();

    for (const file of files) {
        const css = code(read(file));
        for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*(?:,|\))/g)) {
            // A component may define its own local custom property inline (--av, --author);
            // those are set in markup rather than in the token file.
            if (!defined.has(m[1]) && !['--av', '--author'].includes(m[1])) {
                missing.add(`${file}: ${m[1]}`);
            }
        }
    }
    assert.deepEqual([...missing], []);
});

test('spacing and radius are scales rather than a pile of numbers', () => {
    const tokens = read('tokens.css');
    const space = [...tokens.matchAll(/--s-(\d):\s*(\d+)px/g)].map((m) => [Number(m[1]), Number(m[2])]);
    assert.ok(space.length >= 8, 'the spacing scale should cover the range actually used');
    for (const [, px] of space) assert.equal(px % 4, 0, 'every step is a multiple of the 4px base');
    for (let i = 1; i < space.length; i++) {
        assert.ok(space[i][1] > space[i - 1][1], 'the scale must increase');
    }

    const radius = [...tokens.matchAll(/--r-(\d):\s*(\d+)px/g)].map((m) => Number(m[2]));
    for (let i = 1; i < radius.length; i++) assert.ok(radius[i] > radius[i - 1]);
});

test('the shell constrains itself rather than the page', () => {
    const shell = code(read('shell.css'));
    const base = code(read('base.css'));

    assert.match(base, /body\s*\{[^}]*overflow:\s*hidden/,
        'the page itself must never scroll — a column that overflows should show its own bar');
    assert.match(shell, /\.app-shell\s*\{[^}]*height:\s*100dvh/);

    // Grid and flex children default to min-height: auto, which lets a long list push its
    // parent taller instead of scrolling. Every column has to opt out explicitly.
    assert.match(shell, /\.app-body\s*>\s*\*\s*\{[^}]*min-height:\s*0/);
    assert.match(shell, /\.app-body\s*\{[^}]*grid-template-columns:\s*var\(--rail-w\)\s*var\(--sidebar-w\)\s*minmax\(0,\s*1fr\)\s*var\(--members-w\)/);

    // The rows that make the composer stay put while the timeline scrolls.
    assert.match(shell, /\.room\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/);
});

test('narrow windows drop whole columns instead of squeezing them', () => {
    // A 140px member list is not a member list. Each breakpoint must remove a column from
    // the grid template as well as hiding it, or the space stays reserved and empty.
    const shell = code(read('shell.css'));
    const queries = [...shell.matchAll(/@media \(max-width: (\d+)px\)\s*\{([\s\S]*?)\n\}/g)];
    assert.ok(queries.length >= 3, 'expected breakpoints for members, sidebar and rail');

    const widths = queries.map((q) => Number(q[1]));
    for (let i = 1; i < widths.length; i++) {
        assert.ok(widths[i] < widths[i - 1], 'breakpoints must read largest to smallest');
    }
    for (const [, , body] of queries) {
        assert.match(body, /display:\s*none/, 'each breakpoint hides something');
        assert.match(body, /grid-template-columns/, 'and reclaims its column from the grid');
    }
});
