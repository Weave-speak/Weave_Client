// One colour per person, derived from their name.
//
// Deterministic on purpose: everybody sees the same person in the same colour, on every
// client, with nothing stored and nothing to synchronise. The server never sends a colour.
//
// This is the identity hash the live server has used since the beginning. Changing it would
// recolour everyone the crew has learned to recognise at a glance, so it is kept verbatim.

/** A hue in [0, 360) for a username. Stable across clients, sessions and reinstalls. */
export function userHue(name) {
    const u = String(name ?? '');
    let h = 0;
    for (let i = 0; i < u.length; i++) h = (h * 31 + u.charCodeAt(i)) & 0xffff;
    return h % 360;
}

/** The avatar fill. Darker and less saturated than a strand, so white initials stay legible. */
export const avatarColour = (name) => `hsl(${userHue(name)}, 55%, 40%)`;
