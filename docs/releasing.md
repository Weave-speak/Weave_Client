# Releasing

## How an update actually reaches someone

Nobody downloads a 113 MB installer to get an update. They download about a megabyte.

When the app starts it fetches `latest.yml` from the newest GitHub release. If there is a
newer version it fetches two small `.blockmap` files — one for the version installed, one
for the new version — and compares them. Each blockmap lists the content-defined chunks of
its installer with a checksum per chunk. Everything unchanged is copied from the previous
installer, which the NSIS installer cached at
`%LOCALAPPDATA%\weave-client-updater\installer.exe` when it ran. Only the changed chunks are
fetched, over HTTP range requests.

Measured on the real 0.1.0 → 0.1.1 release pair:

```
Full installer:   107.87 MB
Would download:   0.90 MB  (0.8%)
Blocks:           47 changed of 5437
Range requests:   ~8
```

The install then runs silently with `/S`. No wizard, no directory prompt — NSIS wraps the
licence and directory pages in `skipPageIfUpdated` and the updater always passes `--updated`,
so the app lands back in whatever directory the user originally chose, read from
`HKCU\Software\<APP_GUID>\InstallLocation`. A per-user install never elevates, so there is no
UAC prompt either.

This is the same shape as Discord's host updates. Discord's are smaller — around 116 KB
against a 113 MB host — because their app code sits outside the compressed archive as
separately-versioned modules. Ours is one recompressed `app.asar` per release, and roughly a
megabyte is the floor for that. It transfers in under a second, so the floor is fine.

## Why a release is born as a draft

A real user's updater once checked for updates in the middle of a publish: the release
existed, `latest.yml` did not yet, and their launch showed "Update failed" for a 404 that
fixed itself a minute later. So `ensure-release.mjs` now creates the release as a DRAFT —
invisible to every updater — electron-builder attaches its assets to the draft, and
`finish-release.mjs` flips it public only after verifying the exe, the blockmap and
`latest.yml` are all present and uploaded. A missing asset refuses the flip and the
release stays invisible: a failed build to fix, never a half-release to serve.

## Cutting a release

```bash
npm version patch          # or minor
git push --follow-tags
npm run release            # drafts the release, uploads, then publishes it WHOLE
```

`npm run release` regenerates the installer artwork, builds the desktop renderer, packages,
and publishes to GitHub Releases as a pre-release.

**Tag before you publish.** GitHub refuses to create a non-draft release for a tag that does
not exist, and the error — "Published releases must have a valid tag" — arrives after the
113 MB upload has already started. `npm run release` now checks this first and stops with a
useful message instead.

### Why the release is created before the upload

electron-builder publishes its artifacts **concurrently**, and each publisher creates the
release if it does not already exist. When two check at the same instant, both find nothing
and both create one — leaving two releases sharing a tag with the assets split between them.

That failure is nearly invisible. Both releases look correct in the API, but
`/releases/download/<tag>/<file>` resolves to only one of them, so whichever assets landed
on the other simply 404. It happened here on v0.1.2 and v0.1.3: the `.blockmap` went to the
orphan, which would have silently pushed every client onto a full 113 MB download.

`scripts/ensure-release.mjs` creates the release up front so both publishers attach to an
existing one. If you ever see two releases for a tag, move every asset onto the one holding
`latest.yml`, then delete the other — and check the public URLs **after** the delete, not
before, because while the duplicate exists it shadows the tag and every check reports the
wrong answer.

## Checking the delta before shipping

```bash
node scripts/predict-delta.mjs previous.blockmap release/Weave-Setup-<new>.exe.blockmap
```

The previous blockmap is published beside the previous release, so it can just be
downloaded. The script exits non-zero if the delta exceeds 10%, which is the signal that
something recompressed the payload rather than that the code changed a lot.

## Four rules that keep deltas working

Each of these silently turns every user's next update into a full 113 MB download. None of
them produces an error anyone will see.

1. **Never delete or rename a published release asset.** The previous version's `.blockmap`
   must stay reachable at its original URL forever. Tidying up old releases breaks updates
   for everyone still on them.
2. **Never re-upload a rebuilt installer over an existing tag.** The cached `installer.exe`
   on users' disks would no longer match the blockmap byte for byte, and their delta would
   fail its checksum and fall back to a full download. If a release is wrong, cut a new
   version number.
3. **Build every release on the same machine, with the same pinned toolchain.** A different
   7-Zip recompresses everything and makes every block differ. Bumping Electron or
   electron-builder does the same — expect the release straight after any such bump to be a
   full download for everyone, and do not let it happen silently or often.
4. **Do not set `nsis.differentialPackage: false` or switch to the `portable` target.**
   Either one removes the blockmap and turns every update into the full installer. This is
   the single config change that would actually cause the problem people assume they have.

## Verifying an update really was differential

`%APPDATA%\Weave\logs\updater.log` records it. A working delta looks like:

```
Download block maps (old: ".../Weave-Setup-0.1.1.exe.blockmap", new: ...)
File has 47 changed blocks
Full: 110,463.55 KB, To download: 924.12 KB (1%)
Update downloaded { transferredBytes: 946303, differential: true, savedPercent: 99.2 }
```

The line to watch for is `Cannot download differentially, fallback to full download`.
It is logged once and then a hundred megabytes are fetched without further comment.

## Signing

Builds are currently unsigned, so `verifyUpdateCodeSignature` is `false` in
`electron-builder.yml`. That is not a shortcut — electron-updater checks a downloaded
installer's Authenticode signature before running it, and an unsigned build has none, so
leaving the check on would make every update fail verification and be discarded.

What protects the update path today is that `latest.yml` arrives over TLS from GitHub and
carries a SHA-512 that the assembled installer is verified against before it runs. An
attacker would have to compromise the GitHub release itself. Keep two-factor authentication
on the account, and do not move the update feed to a self-hosted origin while unsigned.

When a certificate is obtained, sign **inside** electron-builder. The blockmap is generated
after electron-builder's own signing step, so signing there is safe — but any external
sign-and-re-upload step afterwards invalidates the blockmap and `latest.yml` and silently
kills every delta.
