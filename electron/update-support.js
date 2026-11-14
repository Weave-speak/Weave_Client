// Whether the updater should run at all, and if not, why.
//
// Pure, and in its own file, so it can be asserted on without starting Electron.

/**
 * Platforms whose GitHub releases carry the feed electron-updater reads
 * (latest.yml, latest-linux.yml, ...). Releases are published from a Windows machine, so
 * only Windows has one. A Linux build that checked anyway got a 404 for latest-linux.yml on
 * every launch and showed "Update failed" with no way to dismiss it.
 *
 * Add 'linux' here in the same change that starts publishing the Linux assets.
 */
const PLATFORMS_WITH_A_FEED = new Set(['win32']);

/** A reason to skip the check, or null when it should go ahead. */
export function updateSkipReason({ packaged, platform }) {
    if (!packaged) return 'development build';
    if (!PLATFORMS_WITH_A_FEED.has(platform)) return `no update feed is published for ${platform} yet`;
    return null;
}
