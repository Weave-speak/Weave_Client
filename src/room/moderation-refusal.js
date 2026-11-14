// Saying so when the server refuses an administrator verb.
//
// Moving, server-muting and kicking somebody are fire-and-forget: the menu closes, the
// drag ends, and the only sign of success is the roster changing. A refusal used to look
// exactly like that success minus the roster change — nothing at all — which is how a
// server mute aimed at somebody who turned out to hold an admin flag read as "the button
// did nothing". So the last verb sent is remembered for a moment, and a refusal arriving
// in that moment is turned into a sentence.
//
// The server's error frame does not say which request it answers, so it is matched the
// way slash-command refusals are (room/commands.js, COMMAND_REFUSALS): by code, and by
// being recent. Pure, so the matching is tested without a DOM or a socket.

/** How long after sending a verb an error is still taken to be its answer. */
export const REFUSAL_WINDOW_MS = 5_000;

/**
 * The codes the moderation handlers refuse with, and nothing broader.
 *
 * `forbidden` is the server's gate for a session that is not (or is no longer) allowed the
 * verb at all; `target_is_admin` is somebody aimed at an administrator; `not_permitted` is a
 * tester past the edge of what a tester may do — an open-ended mute, or lifting a mute
 * somebody else placed. The rest are the handlers' own refusals — the person left, the room
 * is text, the room is private.
 */
export const MODERATION_REFUSALS = Object.freeze(new Set([
    'forbidden', 'target_is_admin', 'not_permitted', 'not_yourself', 'no_user', 'no_peer',
    'no_channel', 'text_channel', 'not_a_member', 'internal_error',
]));

/** The acknowledgements that mean the verb went through. */
export const MODERATION_ACKS = Object.freeze(new Set(['adminMoved', 'serverMuteChanged', 'kickedPeer']));

const VERBS = Object.freeze({
    move: { icon: 'lock', lead: (who) => `Could not move ${who}` },
    mute: { icon: 'micOff', lead: (who) => `Could not server-mute ${who}` },
    unmute: { icon: 'micOff', lead: (who) => `Could not lift ${who}'s server mute` },
    kick: { icon: 'power', lead: (who) => `Could not kick ${who}` },
});

/**
 * What was just asked for, to be matched against what comes back.
 *
 * @param {'move'|'mute'|'unmute'|'kick'} action
 * @param {string} who  the display name, as the menu showed it
 */
export const pendingModeration = (action, who, at = Date.now()) => ({ action, who, at });

/**
 * Read one inbound frame against the verb in flight.
 *
 * Returns the pending verb as it stands after this frame — kept while nothing has answered
 * it, dropped on an answer or once it is too old to be answered — and, when the answer
 * was a refusal, what to tell the person.
 *
 * @returns {{ pending: object|null, refusal: { icon: string, text: string }|null }}
 */
export function readModerationFrame(pending, msg, now = Date.now()) {
    if (!pending) return { pending: null, refusal: null };
    if (now - pending.at > REFUSAL_WINDOW_MS) return { pending: null, refusal: null };
    if (MODERATION_ACKS.has(msg?.type)) return { pending: null, refusal: null };
    if (msg?.type !== 'error' || !MODERATION_REFUSALS.has(msg.code)) return { pending, refusal: null };

    const verb = VERBS[pending.action] ?? VERBS.move;
    const who = pending.who || 'them';
    const why = String(msg.message ?? '').trim();
    return {
        pending: null,
        refusal: {
            icon: verb.icon,
            text: why ? `${verb.lead(who)}: ${why}` : `${verb.lead(who)}.`,
        },
    };
}
