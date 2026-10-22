// The bubbles that drift over the chat.
//
// Ported from the web app's bubbles.js, keeping what made it pleasant: small round photos
// moving slowly, bouncing off each other and the edges, which can be picked up and dropped
// somewhere else, and which open on a plain click. Plain DOM elements moved by transform —
// a canvas would need its own hit-testing, its own labels and its own focus handling, and
// there are never more than a handful of these.
//
// The physics is a pure function (stepBubbles) so it can be tested without a browser; the
// class around it owns the elements, the pointer and the clock.
//
// Stopping freezes the bubbles where they are rather than hiding them: they stay visible,
// clickable and draggable. "Still background" and reduced motion ask for stillness, not for
// a feature to vanish.

/** 48px across: big enough to recognise a face, small enough not to cover a sentence. */
export const BUBBLE_RADIUS = 24;
const MIN_SPEED = 8;     // px/s
const MAX_SPEED = 18;    // px/s — ambient, never something to chase
const DRAG_THRESHOLD = 5;
// Slow things do not need sixty frames a second; twenty-four is smooth at these speeds and
// is a third of the work.
const FRAME_INTERVAL = 1 / 24;

/** A random heading at an unhurried speed. */
export function randomVelocity(random = Math.random) {
    const speed = MIN_SPEED + random() * (MAX_SPEED - MIN_SPEED);
    const angle = random() * Math.PI * 2;
    return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
}

/**
 * Move every bubble `dt` seconds within a `w` × `h` field: drift, bounce off the edges, and
 * push apart any two that touch, swapping the parts of their velocities that point at each
 * other — an equal-mass elastic collision, which reads as two soap bubbles meeting.
 *
 * Mutates the bubbles in place and returns them. A held bubble neither moves nor is moved.
 * Deliberately O(n²): there are a few of these, not a few hundred.
 */
export function stepBubbles(list, w, h, dt) {
    if (!w || !h) return list;
    for (const b of list) {
        if (b.dragging) continue;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); }
        if (b.x + b.r > w) { b.x = w - b.r; b.vx = -Math.abs(b.vx); }
        if (b.y - b.r < 0) { b.y = b.r; b.vy = Math.abs(b.vy); }
        if (b.y + b.r > h) { b.y = h - b.r; b.vy = -Math.abs(b.vy); }
    }
    for (let i = 0; i < list.length; i += 1) {
        const a = list[i];
        if (a.dragging) continue;
        for (let j = i + 1; j < list.length; j += 1) {
            const b = list[j];
            if (b.dragging) continue;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.hypot(dx, dy) || 0.001;
            const minDist = a.r + b.r;
            if (dist >= minDist) continue;
            const overlap = (minDist - dist) / 2;
            const nx = dx / dist;
            const ny = dy / dist;
            a.x -= nx * overlap; a.y -= ny * overlap;
            b.x += nx * overlap; b.y += ny * overlap;
            const av = a.vx * nx + a.vy * ny;
            const bv = b.vx * nx + b.vy * ny;
            a.vx += (bv - av) * nx; a.vy += (bv - av) * ny;
            b.vx += (av - bv) * nx; b.vy += (av - bv) * ny;
        }
    }
    return list;
}

/** Keep a bubble inside the field — after a resize, or while it is being dragged. */
export function clampBubble(b, w, h) {
    b.x = Math.min(Math.max(b.r, b.x), Math.max(b.r, w - b.r));
    b.y = Math.min(Math.max(b.r, b.y), Math.max(b.r, h - b.r));
    return b;
}

export class BubblesField {
    /**
     * @param {HTMLElement} layer   the element the bubbles live in; they never leave it
     * @param {object} options
     * @param {(id: string) => void} options.onOpen  a bubble was clicked, not dragged
     */
    constructor(layer, { onOpen = () => {} } = {}) {
        this.layer = layer;
        this.onOpen = onOpen;
        this.bubbles = new Map();
        this.frame = 0;
        this.last = 0;
        this.acc = 0;
        this.wanted = false;
        this.tick = this.tick.bind(this);
        this.onVisibility = () => this.sync();
        document.addEventListener('visibilitychange', this.onVisibility);
    }

    /** Whether the bubbles should be moving. They are always shown; this is only motion. */
    setMoving(moving) {
        this.wanted = Boolean(moving);
        this.sync();
    }

    sync() {
        const reduced = typeof matchMedia === 'function'
            && matchMedia('(prefers-reduced-motion: reduce)').matches;
        const run = this.wanted && !reduced && !document.hidden && this.bubbles.size > 0;
        if (run && !this.frame) {
            this.clampAll();
            this.last = 0;
            this.frame = requestAnimationFrame(this.tick);
        } else if (!run && this.frame) {
            cancelAnimationFrame(this.frame);
            this.frame = 0;
        }
    }

    has(id) { return this.bubbles.has(id); }
    ids() { return [...this.bubbles.keys()]; }

    spawn(id, { name = '', photoUrl = null, unread = false } = {}) {
        if (this.bubbles.has(id)) return;
        const w = this.layer.clientWidth || 300;
        const h = this.layer.clientHeight || 300;
        const r = BUBBLE_RADIUS;

        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'bubble bubble-enter';
        el.dataset.bubble = id;
        el.setAttribute('aria-label', name ? `Bubble: ${name}` : 'Bubble');
        el.style.width = el.style.height = `${r * 2}px`;
        const face = document.createElement('span');
        face.className = 'bubble-face';
        el.append(face);
        const label = document.createElement('span');
        label.className = 'bubble-label';
        label.textContent = name;
        el.append(label);
        this.layer.append(el);

        const b = {
            id, el, face, r,
            x: r + Math.random() * Math.max(1, w - r * 2),
            y: r + Math.random() * Math.max(1, h - r * 2),
            ...randomVelocity(),
            dragging: false, moved: false, pointerId: null, startX: 0, startY: 0,
        };
        this.bubbles.set(id, b);
        this.setPhoto(id, photoUrl);
        this.setUnread(id, unread);
        this.place(b);
        this.wireDrag(b);
        requestAnimationFrame(() => el.classList.remove('bubble-enter'));
        this.sync();
    }

    remove(id) {
        const b = this.bubbles.get(id);
        if (!b) return;
        this.bubbles.delete(id);
        b.el.classList.add('bubble-exit');
        setTimeout(() => b.el.remove(), 220);
        this.sync();
    }

    setPhoto(id, url) {
        const b = this.bubbles.get(id);
        if (!b || !url) return;
        // Set as a property, never interpolated into markup: the URL is an object URL made
        // here, but the rule is the same everywhere.
        b.face.style.backgroundImage = `url("${String(url).replace(/"/g, '%22')}")`;
    }

    setUnread(id, unread) {
        this.bubbles.get(id)?.el.classList.toggle('is-unread', Boolean(unread));
    }

    /** Where a bubble is on screen, for anchoring its popup. */
    rectOf(id) {
        return this.bubbles.get(id)?.el.getBoundingClientRect() ?? null;
    }

    place(b) {
        b.el.style.transform = `translate3d(${(b.x - b.r).toFixed(1)}px, ${(b.y - b.r).toFixed(1)}px, 0)`;
        // The name folds out towards whichever side has room.
        b.el.classList.toggle('label-left', b.x > (this.layer.clientWidth || 0) / 2);
    }

    clampAll() {
        const w = this.layer.clientWidth;
        const h = this.layer.clientHeight;
        if (!w || !h) return;
        for (const b of this.bubbles.values()) this.place(clampBubble(b, w, h));
    }

    wireDrag(b) {
        const el = b.el;
        el.addEventListener('pointerdown', (event) => {
            if (event.button != null && event.button !== 0) return;
            event.preventDefault();
            b.dragging = true;
            b.moved = false;
            b.startX = event.clientX;
            b.startY = event.clientY;
            b.vx = 0; b.vy = 0;
            b.pointerId = event.pointerId;
            try { el.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
        });
        el.addEventListener('pointermove', (event) => {
            if (!b.dragging || event.pointerId !== b.pointerId) return;
            const far = Math.hypot(event.clientX - b.startX, event.clientY - b.startY) > DRAG_THRESHOLD;
            if (!b.moved && far) b.moved = true;
            if (!b.moved) return;
            const rect = this.layer.getBoundingClientRect();
            b.x = event.clientX - rect.left;
            b.y = event.clientY - rect.top;
            this.place(clampBubble(b, rect.width, rect.height));
        });
        const end = () => {
            if (!b.dragging) return;
            b.dragging = false;
            try { el.releasePointerCapture(b.pointerId); } catch { /* already released */ }
            b.pointerId = null;
            // Dropped: off it goes again in a new direction. Not moved: it was a click.
            if (b.moved) Object.assign(b, randomVelocity());
            else this.onOpen(b.id);
        };
        el.addEventListener('pointerup', end);
        el.addEventListener('pointercancel', end);
        // The keyboard's way in: a focused bubble opens on Enter or Space like any button.
        el.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.onOpen(b.id);
            }
        });
    }

    tick(now) {
        const dt = Math.min(0.05, this.last ? (now - this.last) / 1000 : 0.016);
        this.last = now;
        this.acc += dt;
        if (this.acc >= FRAME_INTERVAL) {
            const list = [...this.bubbles.values()];
            stepBubbles(list, this.layer.clientWidth, this.layer.clientHeight, this.acc);
            for (const b of list) if (!b.dragging) this.place(b);
            this.acc = 0;
        }
        this.frame = requestAnimationFrame(this.tick);
    }

    destroy() {
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        document.removeEventListener('visibilitychange', this.onVisibility);
        for (const b of this.bubbles.values()) b.el.remove();
        this.bubbles.clear();
    }
}
