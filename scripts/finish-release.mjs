// Make the draft release visible — only once it is WHOLE.
//
// ensure-release.mjs creates the release as a draft; electron-builder attaches its
// assets to it; this flips draft to published. The check between those is the point:
// the exe, its blockmap and latest.yml must all be present and 'uploaded', or the flip
// is refused and the release stays invisible to every updater. A missing asset here is
// a failed build to fix, never something to ship around.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OWNER = 'Weave-speak';
const REPO = 'Weave_Client';
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;

async function gh(path, init = {}) {
    return fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            ...(init.headers ?? {}),
        },
    });
}

async function main() {
    if (!token) {
        console.error('GH_TOKEN is not set; cannot publish the release.');
        process.exit(1);
    }
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    const tag = `v${pkg.version}`;

    // Drafts are invisible to the by-tag endpoint; list and find.
    const listed = await gh('/releases?per_page=10');
    if (!listed.ok) {
        console.error(`Could not list releases: ${listed.status}`);
        process.exit(1);
    }
    const release = (await listed.json()).find((r) => r.tag_name === tag);
    if (!release) {
        console.error(`No release found for ${tag}.`);
        process.exit(1);
    }
    if (!release.draft) {
        console.log(`${tag} is already published.`);
        return;
    }

    const names = release.assets.map((a) => `${a.name}:${a.state}`);
    const need = ['latest.yml', `Weave-Setup-${pkg.version}.exe`, `Weave-Setup-${pkg.version}.exe.blockmap`];
    const missing = need.filter((n) => !release.assets.some((a) => a.name === n && a.state === 'uploaded'));
    if (missing.length) {
        console.error(`Refusing to publish ${tag}: missing ${missing.join(', ')} (have: ${names.join(', ')})`);
        process.exit(1);
    }

    const flipped = await gh(`/releases/${release.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ draft: false }),
    });
    if (!flipped.ok) {
        console.error(`Could not publish ${tag}: ${flipped.status} ${await flipped.text()}`);
        process.exit(1);
    }
    console.log(`${tag} published whole: ${need.join(', ')} all uploaded.`);
}

await main();
