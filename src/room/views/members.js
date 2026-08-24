// The right column: everyone on the server, grouped.
//
// Grouped by PRESENCE, not by role. The designs group by role, but this build has only
// admins and users, so a role grouping would produce one group called "Admin" with one
// person in it and one called "Member" with everybody else — which tells you less than
// nothing. Presence is the thing you actually scan this list for: who can I talk to now.
//
// The grouping order below is that question in order of usefulness.

import { esc } from '../../ui/dom.js';
import { avatar, personMarks, displayName, adminBadge } from './parts.js';

/** In the room with you first, then reachable, then not. */
const GROUPS = [
    { key: 'here', label: 'In this room', match: (p, ctx) => p.roomId && p.roomId === ctx.roomId },
    { key: 'elsewhere', label: 'In another room', match: (p) => Boolean(p.roomId) },
    { key: 'online', label: 'Online', match: (p) => p.presence !== 'offline' },
    { key: 'offline', label: 'Offline', match: () => true },
];

/**
 * Put each person in exactly one group, in the order above.
 *
 * First match wins, and the last group matches everything, so nobody can fall through and
 * silently vanish from the list — a roster that quietly drops people is worse than one
 * that puts someone in the wrong group.
 */
export function groupMembers(people = [], { roomId = null } = {}) {
    const buckets = new Map(GROUPS.map((g) => [g.key, []]));
    for (const person of people) {
        const group = GROUPS.find((g) => g.match(person, { roomId }));
        buckets.get(group.key).push(person);
    }
    return GROUPS
        .map((g) => ({ ...g, people: buckets.get(g.key) }))
        .filter((g) => g.people.length);
}

const memberRow = (person) => `
  <li>
    <button type="button" class="member-row ${esc(person.presence === 'offline' ? 'offline' : 'online')}"
            data-person="${esc(person.username)}">
      ${avatar(person, { size: 'sm' })}
      <span class="member-name">${displayName(person)}</span>
      ${adminBadge(person)}
      ${personMarks(person)}
    </button>
  </li>`;

const group = (g) => `
  <h3 class="member-group">${esc(g.label)} — ${esc(g.people.length)}</h3>
  <ul class="member-list">${g.people.map(memberRow).join('')}</ul>`;

/** The grouped list, exported so a presence change can replace just this. */
export const memberGroups = (people, roomId) =>
    groupMembers(people, { roomId }).map(group).join('');

export function members({ people = [], roomId = null } = {}) {
    return `
    <aside class="members" aria-label="Members">
      <header class="members-head">
        <span class="members-title" id="membersCount">Members — ${esc(people.length)}</span>
      </header>
      <div class="members-scroll" id="membersScroll">${memberGroups(people, roomId)}</div>
    </aside>`;
}
