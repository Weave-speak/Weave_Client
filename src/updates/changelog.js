// What's new: the client's own CHANGELOG.md, shown once after an update.
//
// The web app had a What's New box fed by the server. This one is fed by the app instead,
// because the thing that changed under somebody after an update is the app — and because
// the notes then ship inside the build that they describe, so they can never be about a
// different version than the one running.
//
// Pure: parsing, choosing which versions are new to this person, and rendering. The file is
// handed in as text (vite's ?raw import in whats-new.js), so the tests can read the real
// CHANGELOG.md with fs and no bundler.

import { esc } from '../ui/dom.js';

/** How many versions one "what's new" may show, so a long-unopened app is not a wall. */
export const MAX_VERSIONS = 5;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Compare two x.y.z versions. Anything that is not one sorts below everything that is. */
export function compareVersions(a, b) {
    const pa = String(a ?? '').match(SEMVER);
    const pb = String(b ?? '').match(SEMVER);
    if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
    for (let i = 1; i <= 3; i++) {
        const d = Number(pa[i]) - Number(pb[i]);
        if (d) return d;
    }
    return 0;
}

/**
 * The changelog as data: versions, each with its sections, each with its items, each item
 * a list of paragraphs. Keep-a-Changelog as this repository writes it — a bullet per item,
 * continuation lines indented, a blank line between paragraphs of one item.
 *
 * "Unreleased" parses like any other heading, and is simply never chosen: it is not a
 * version anybody is running.
 */
export function parseChangelog(text) {
    const versions = [];
    let version = null;
    let section = null;
    let item = null;

    for (const line of String(text ?? '').split(/\r?\n/)) {
        const heading = line.match(/^## \[([^\]]+)\](?:\s*-\s*(\S+))?/);
        if (heading) {
            version = { version: heading[1].trim(), date: heading[2] ?? null, sections: [] };
            versions.push(version);
            section = null;
            item = null;
            continue;
        }
        if (!version) continue;

        const sub = line.match(/^### (.+)/);
        if (sub) {
            section = { heading: sub[1].trim(), items: [] };
            version.sections.push(section);
            item = null;
            continue;
        }
        if (!section) continue;

        const bullet = line.match(/^- (.*)/);
        if (bullet) {
            item = { paragraphs: [bullet[1].trim()] };
            section.items.push(item);
            continue;
        }
        if (!item) continue;

        if (!line.trim()) {
            // A blank line opens a new paragraph — but only once, however many there are.
            if (item.paragraphs.at(-1) !== '') item.paragraphs.push('');
            continue;
        }
        if (/^\s+/.test(line)) {
            const last = item.paragraphs.length - 1;
            item.paragraphs[last] = item.paragraphs[last] ? `${item.paragraphs[last]} ${line.trim()}` : line.trim();
            continue;
        }
        // Anything else at the left margin ends the item.
        item = null;
    }

    for (const v of versions) {
        for (const s of v.sections) {
            for (const i of s.items) i.paragraphs = i.paragraphs.filter(Boolean);
        }
    }
    return versions;
}

/**
 * The versions to show someone who last saw `lastSeen` and is now running `current`:
 * newer than the one, no newer than the other, newest first, and not too many.
 */
export function versionsBetween(versions = [], lastSeen, current) {
    return versions
        .filter((v) => SEMVER.test(v.version))
        .filter((v) => compareVersions(v.version, lastSeen) > 0 && compareVersions(v.version, current) <= 0)
        .sort((a, b) => compareVersions(b.version, a.version))
        .slice(0, MAX_VERSIONS);
}

/** The notes for one version and the few before it, for opening on demand. */
export function recentVersions(versions = [], current, count = 3) {
    return versions
        .filter((v) => SEMVER.test(v.version) && compareVersions(v.version, current) <= 0)
        .sort((a, b) => compareVersions(b.version, a.version))
        .slice(0, count);
}

/**
 * Whether to show the notes at start-up, and what to remember.
 *
 * A first run shows nothing: somebody who has just installed the app has not had anything
 * change under them, and greeting them with a list of fixes to bugs they never met is noise.
 */
export function whatsNewDecision({ lastSeen = null, current }) {
    if (!SEMVER.test(String(current ?? ''))) return { show: false, remember: null };
    if (!lastSeen) return { show: false, remember: current };
    return { show: compareVersions(current, lastSeen) > 0, remember: current };
}

/**
 * The little Markdown the changelog uses: **bold** and `code`. Escaped FIRST, so the only
 * markup that can exist afterwards is the markup added here.
 */
export function inline(text) {
    return esc(text)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1');
}

/** The notes, as markup for the dialog. */
export function whatsNewView(versions = [], { current = '' } = {}) {
    if (!versions.length) {
        return `
        <div class="whats-new">
          <h2 class="panel-title">What's new</h2>
          <p class="panel-lead">There are no notes for this version.</p>
          <div class="whats-new-actions"><button type="button" class="btn primary" data-whats-new-close>Close</button></div>
        </div>`;
    }
    return `
    <div class="whats-new">
      <h2 class="panel-title">What's new${current ? ` in Weave ${esc(current)}` : ''}</h2>
      ${versions.map((v) => `
      <section class="whats-new-version">
        <h3 class="whats-new-heading">${esc(v.version)}${v.date ? ` <span class="whats-new-date">${esc(v.date)}</span>` : ''}</h3>
        ${v.sections.map((s) => `
        <h4 class="whats-new-kind">${esc(s.heading)}</h4>
        <ul class="whats-new-items">
          ${s.items.map((i) => `<li>${i.paragraphs.map((p) => `<p>${inline(p)}</p>`).join('')}</li>`).join('')}
        </ul>`).join('')}
      </section>`).join('')}
      <div class="whats-new-actions"><button type="button" class="btn primary" data-whats-new-close>Got it</button></div>
    </div>`;
}
