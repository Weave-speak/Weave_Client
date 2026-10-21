// Slash commands: /roll, /flip, and whatever else the server offers.
//
// The server keeps them as their own message type rather than as text it inspects on the
// way past, so a command works on a voice-only server and its result is never mistaken for
// somebody typing the same words by hand. This side decides which lines ARE commands, and
// offers the list as you type a slash. Pure, like mentions.js beside it — the popover
// itself is wired in index.js.
//
// Only a name the server actually advertised is a command. "/shrug" on a server without a
// shrug, or a path somebody pasted, is a message, and is sent as one: refusing to send it
// would be a strange way to fail at something nobody asked for.

/** The server takes at most this many arguments and ignores the rest. */
const MAX_ARGS = 4;

const knownName = (name, commands) =>
    commands.some((c) => String(c.name).toLowerCase() === name);

/**
 * Whether a composed line is a command, and which.
 *
 * Returns { command, args } or null. A doubled slash is the way out — "//roll" is sent as
 * the text "/roll", the same escape every chat program with commands has settled on.
 */
export function parseCommand(body, commands = []) {
    const text = String(body ?? '').trim();
    if (!text.startsWith('/') || text.startsWith('//')) return null;
    const [head, ...rest] = text.slice(1).split(/\s+/);
    const name = head.toLowerCase();
    if (!name || !knownName(name, commands)) return null;
    return { command: name, args: rest.filter(Boolean).slice(0, MAX_ARGS) };
}

/**
 * The command name being typed, if the caret is still inside it.
 *
 * Only at the very start of the composer: a slash in the middle of a sentence is a
 * fraction or a path. Once a space follows the name the choice is made and the offer
 * withdraws, so the arguments are typed in peace.
 */
export function commandQuery(text, caret) {
    const upTo = String(text ?? '').slice(0, caret ?? 0);
    if (!upTo.startsWith('/') || upTo.startsWith('//')) return null;
    const query = upTo.slice(1);
    if (/\s/.test(query)) return null;
    return { query };
}

/**
 * The commands a query could mean. A name typed out in full offers nothing, so that Enter
 * after "/flip" sends it instead of completing it to itself.
 */
export function matchCommands(query, commands = []) {
    const q = String(query ?? '').toLowerCase();
    const hits = commands.filter((c) => String(c.name).toLowerCase().startsWith(q));
    if (hits.length === 1 && String(hits[0].name).toLowerCase() === q) return [];
    return hits;
}

/** Replace what has been typed of the name with the whole name and a space for arguments. */
export function completeCommand(text, caret, name) {
    const after = String(text ?? '').slice(caret ?? 0).replace(/^\S*/, '');
    const head = `/${name} `;
    return { text: head + after.replace(/^\s+/, ''), caret: head.length };
}

/**
 * A result, as a line in the timeline.
 *
 * Shaped like the "started streaming" lines rather than like a message: it is something
 * that happened in the room, said by the server on the person's behalf, and it must not
 * look like they typed it.
 */
export function resultItem(frame) {
    const who = frame.by?.displayName || frame.by?.username || 'Someone';
    return {
        kind: 'system',
        id: `cmd-${frame.command}-${frame.by?.cid ?? 'x'}-${frame.at}`,
        icon: 'dice',
        who,
        text: String(frame.text ?? ''),
        createdAt: Number(frame.at) || Date.now(),
    };
}

/**
 * A refusal, as a line only the person who typed it sees.
 *
 * The server sends usage errors to the sender alone — broadcasting somebody's typo is
 * noise — so this is minted locally and never leaves this machine.
 */
export function refusalItem(message, at = Date.now()) {
    return {
        kind: 'system',
        id: `cmd-error-${at}`,
        icon: 'dice',
        who: '',
        text: String(message ?? 'That command did not work.'),
        createdAt: at,
        local: true,
    };
}

/**
 * The error codes that answer a command. The server's error frame does not say which
 * request it refuses, so a refusal is matched to a command by code and by being recent.
 * `unknown_type` is the module having been switched off since the list was fetched.
 */
export const COMMAND_REFUSALS = new Set([
    'bad_usage', 'unknown_command', 'disabled', 'not_joined', 'no_channel', 'text_not_allowed',
    'unknown_type',
]);
