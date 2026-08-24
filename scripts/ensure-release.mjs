// Create the GitHub release before electron-builder uploads to it.
//
// electron-builder publishes its artifacts CONCURRENTLY, and each publisher creates the
// release if it does not already exist. When two of them check at the same moment, both
// find nothing and both create one — leaving two releases sharing a single tag with the
// assets split between them.
//
// That failure is close to invisible. Both releases look fine in the API. But
// /releases/download/<tag>/<file> resolves to only one of them, so whichever assets landed
// on the other simply 404. It happened here on v0.1.2 and v0.1.3: the .blockmap went to the
// orphan, so every client would have silently fallen back to downloading the full 113 MB
// installer instead of a delta, with one line in a log nobody reads.
//
// Creating the release first removes the race: both publishers then find an existing
// release and attach to it.
//
//   node scripts/ensure-release.mjs [--tag v1.2.3]
//
// Idempotent. Safe to run when the release already exists.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OWNER = 'Weave-speak';
const REPO = 'Weave_Client';

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;

async function gh(path, init = {}) {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            ...(init.headers ?? {}),
        },
    });
    return res;
}

async function main() {
    if (!token) {
        console.error('GH_TOKEN is not set; cannot create the release.');
        process.exit(1);
    }

    const tagArg = process.argv.indexOf('--tag');
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    const tag = tagArg === -1 ? `v${pkg.version}` : process.argv[tagArg + 1];

    // By-tag lookup misses drafts, so search the list too — a rerun after a failed
    // publish must find its own draft rather than trying to create a second release.
    const existing = await gh(`/releases/tags/${tag}`);
    if (existing.ok) {
        const release = await existing.json();
        console.log(`${tag} already exists (id ${release.id}) with ${release.assets.length} asset(s).`);
        return;
    }
    const listed = await gh('/releases?per_page=10');
    if (listed.ok) {
        const draft = (await listed.json()).find((r) => r.tag_name === tag);
        if (draft) {
            console.log(`${tag} already exists as a draft (id ${draft.id}).`);
            return;
        }
    }
    if (existing.status !== 404) {
        console.error(`Unexpected response looking up ${tag}: ${existing.status} ${await existing.text()}`);
        process.exit(1);
    }

    // GitHub refuses to publish a non-draft release for a tag that does not exist, and the
    // error arrives only after the upload has begun.
    const ref = await gh(`/git/ref/tags/${tag}`);
    if (!ref.ok) {
        console.error(`Tag ${tag} does not exist on the remote. Push it first:\n`
            + `  git tag ${tag} && git push origin ${tag}`);
        process.exit(1);
    }

    const created = await gh('/releases', {
        method: 'POST',
        body: JSON.stringify({
            tag_name: tag,
            name: `Weave ${tag.replace(/^v/, '')}`,
            prerelease: true,
            // DRAFT until every asset is verified uploaded (finish-release.mjs flips it).
            // A visible half-uploaded release once handed a real user's updater a 404
            // for latest.yml mid-publish, which reads as "Update failed" on their side.
            draft: true,
            body: 'Assets are uploaded by electron-builder immediately after this release is created.',
        }),
    });

    if (!created.ok) {
        console.error(`Could not create ${tag}: ${created.status} ${await created.text()}`);
        process.exit(1);
    }
    console.log(`Created ${tag} (id ${(await created.json()).id}). electron-builder will attach its assets to it.`);
}

await main();
