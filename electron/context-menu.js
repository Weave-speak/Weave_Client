// What a right-click offers in the desktop app.
//
// Electron shows no context menu at all unless the app builds one, so until this existed a
// right-click in the desktop app did nothing anywhere: no Paste in a message box, no Copy on
// selected text, and no way to copy a picture out of the chat to paste it somewhere else, a
// bubble included. A browser offers all of that for free; this is the part of it a chat app
// needs.
//
// Pure, so the choices can be tested without Electron: it turns Chromium's context-menu
// params into item descriptions, and app.js turns those into a Menu. The page's own menus
// (a person's, opened by right-clicking their name) call preventDefault, and Chromium then
// never raises this one, so the two cannot both appear.

/**
 * @param {object} params  Electron's context-menu params: isEditable, selectionText,
 *   editFlags, mediaType, hasImageContents, linkURL
 * @returns {object[]} Electron menu items, plus two actions app.js carries out itself:
 *   { action: 'copy-image' } and { action: 'copy-link' }
 */
export function contextMenuItems(params = {}) {
    const flags = params.editFlags ?? {};
    const groups = [];

    if (params.mediaType === 'image' && params.hasImageContents) {
        groups.push([{ action: 'copy-image', label: 'Copy image' }]);
    }
    if (params.linkURL) {
        groups.push([{ action: 'copy-link', label: 'Copy link' }]);
    }

    if (params.isEditable) {
        // Offered even when greyed out, so the menu's shape never moves under the pointer.
        groups.push([
            { role: 'cut', enabled: Boolean(flags.canCut) },
            { role: 'copy', enabled: Boolean(flags.canCopy) },
            { role: 'paste', enabled: Boolean(flags.canPaste) },
        ], [
            { role: 'selectAll', enabled: flags.canSelectAll !== false },
        ]);
    } else if (String(params.selectionText ?? '').trim()) {
        groups.push([{ role: 'copy' }]);
    }

    return groups.flatMap((group, i) => (i ? [{ type: 'separator' }, ...group] : group));
}
