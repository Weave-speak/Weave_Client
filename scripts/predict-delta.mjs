// How big the next update will actually be, before anyone ships it.
//
// electron-updater does not download a whole installer for an update. It compares the
// blockmap of the new installer against the blockmap of the one already on the user's disk,
// and fetches only the blocks that differ, using HTTP range requests. Everything unchanged
// is copied from the previous installer, which the NSIS installer cached at
// %LOCALAPPDATA%/<updaterCacheDirName>/installer.exe when it ran.
//
// That mechanism is silent in both directions. When it works, nobody notices. When it
// breaks, it also says nothing — every failure path falls back to downloading the full
// installer with a single line in a log nobody reads. The difference between the two is
// a hundred megabytes per user per release.
//
// So this script runs the same comparison ahead of time and fails the release if the delta
// has blown up, which is the signal that something in the pipeline changed: a different
// build machine, a bumped Electron or electron-builder, a toggled asar option. Any of those
// recompresses the payload and makes every block differ.
//
//   node scripts/predict-delta.mjs <previous>.blockmap <new>.blockmap [--max-percent 10]
//
// The blockmaps are published beside every release, so the previous one can simply be
// downloaded from the last GitHub release.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

/** A blockmap is gzipped JSON: { version, files: [{ name, offset, checksums, sizes }] }. */
function readBlockmap(path) {
    const parsed = JSON.parse(gunzipSync(readFileSync(path)).toString());
    if (!Array.isArray(parsed?.files)) {
        throw new Error(`${path} is not a blockmap (no files array)`);
    }
    return parsed;
}

/**
 * Which blocks the updater would have to fetch.
 *
 * Blocks are matched by checksum, and a checksum may legitimately appear more than once —
 * runs of identical bytes are common in an installer. Each occurrence in the old file can
 * satisfy exactly one occurrence in the new file, so the counts are decremented as they are
 * consumed. Treating the old blocks as a set rather than a multiset would over-count reuse
 * and predict a smaller download than really happens.
 */
export function planDownload(oldFile, newFile) {
    const available = new Map();
    for (const checksum of oldFile.checksums) {
        available.set(checksum, (available.get(checksum) ?? 0) + 1);
    }

    let download = 0;
    let reuse = 0;
    let changedBlocks = 0;
    let ranges = 0;
    let previousWasDownload = false;

    newFile.checksums.forEach((checksum, i) => {
        const size = newFile.sizes[i];
        const spare = available.get(checksum) ?? 0;

        if (spare > 0) {
            available.set(checksum, spare - 1);
            reuse += size;
            previousWasDownload = false;
            return;
        }

        download += size;
        changedBlocks += 1;
        // Adjacent changed blocks are coalesced into one range request, so the request
        // count is a better proxy for latency than the block count is.
        if (!previousWasDownload) ranges += 1;
        previousWasDownload = true;
    });

    const total = download + reuse;
    return {
        totalBytes: total,
        downloadBytes: download,
        reuseBytes: reuse,
        percent: total ? (download / total) * 100 : 0,
        blocks: newFile.checksums.length,
        changedBlocks,
        rangeRequests: ranges,
    };
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;

function main(argv) {
    const maxIndex = argv.indexOf('--max-percent');
    const maxPercent = maxIndex === -1 ? 10 : Number(argv[maxIndex + 1]);

    // The value after --max-percent is not a file. Filtering only on the leading dashes
    // swallowed it as a third path and turned the gate into a usage error, which in CI
    // reads as "the gate is broken" rather than "the delta is bad".
    //
    // The guard on -1 is the part that bit second: with no flag present, maxIndex is -1 and
    // `maxIndex + 1` is 0, which quietly excluded the FIRST argument instead of nothing.
    const valueIndex = maxIndex === -1 ? -1 : maxIndex + 1;
    const files = argv.filter((a, i) => !a.startsWith('--') && i !== valueIndex);

    if (files.length !== 2) {
        console.error('usage: node scripts/predict-delta.mjs <previous>.blockmap <new>.blockmap [--max-percent N]');
        process.exit(2);
    }

    const [oldMap, newMap] = files.map(readBlockmap);
    const plan = planDownload(oldMap.files[0], newMap.files[0]);

    console.log(`Full installer:   ${mb(plan.totalBytes)}`);
    console.log(`Would download:   ${mb(plan.downloadBytes)}  (${plan.percent.toFixed(1)}%)`);
    console.log(`Reused locally:   ${mb(plan.reuseBytes)}`);
    console.log(`Blocks:           ${plan.changedBlocks} changed of ${plan.blocks}`);
    console.log(`Range requests:   ~${plan.rangeRequests}`);

    if (plan.percent > maxPercent) {
        console.error(
            `\nFAIL: a ${plan.percent.toFixed(1)}% delta exceeds the ${maxPercent}% limit.\n`
            + 'Something recompressed the payload — most likely a different build machine, a\n'
            + 'bumped Electron or electron-builder, or a changed asar setting. Every user would\n'
            + `download ${mb(plan.downloadBytes)} instead of a fraction of it. Publishing anyway is a\n`
            + 'choice, not an accident: pass --max-percent to raise the bar deliberately.',
        );
        process.exit(1);
    }
    console.log(`\nOK: within the ${maxPercent}% limit.`);
}

// Only run when invoked directly, so the planner can be imported by a test.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
    main(process.argv.slice(2));
}
