// Installer artwork.
//
// NSIS wants Windows bitmaps at two fixed sizes, and it is fussy: 24-bit, uncompressed,
// bottom-up, rows padded to a four-byte boundary. Anything else silently renders as
// nothing, which is a miserable thing to debug.
//
// These are generated rather than committed as opaque binaries, so the art can be changed
// by editing numbers instead of opening an image editor, and so a change to the palette is
// one line rather than a re-export. The strands use the same sine-sum as the room
// background, which is what makes the installer look like the application rather than like
// a generic wizard wearing its colours.
//
//   node scripts/make-installer-art.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');

/** The palette, matching src/styles/tokens.css. */
const BG_TOP = [0x14, 0x11, 0x24];
const BG_BOTTOM = [0x08, 0x07, 0x0f];
const STRAND_HUES = [268, 290, 232, 312];

/** Write a 24-bit uncompressed BMP. `pixel(x, y)` returns [r, g, b]. */
function writeBmp(path, width, height, pixel) {
    const rowBytes = width * 3;
    const padding = (4 - (rowBytes % 4)) % 4;
    const stride = rowBytes + padding;
    const pixels = Buffer.alloc(stride * height);

    for (let y = 0; y < height; y++) {
        // BMP rows run bottom-up.
        const row = (height - 1 - y) * stride;
        for (let x = 0; x < width; x++) {
            const [r, g, b] = pixel(x, y);
            const at = row + x * 3;
            pixels[at] = b;          // BGR, not RGB
            pixels[at + 1] = g;
            pixels[at + 2] = r;
        }
    }

    const header = Buffer.alloc(54);
    header.write('BM', 0);
    header.writeUInt32LE(54 + pixels.length, 2);
    header.writeUInt32LE(54, 10);          // pixel data offset
    header.writeUInt32LE(40, 14);          // DIB header size
    header.writeInt32LE(width, 18);
    header.writeInt32LE(height, 22);
    header.writeUInt16LE(1, 26);           // planes
    header.writeUInt16LE(24, 28);          // bits per pixel
    header.writeUInt32LE(pixels.length, 34);
    header.writeInt32LE(2835, 38);         // 72 DPI, in pixels per metre
    header.writeInt32LE(2835, 42);

    writeFileSync(path, Buffer.concat([header, pixels]));
    return 54 + pixels.length;
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** HSL to RGB, for the strand colours. */
function hsl(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = (h % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
        : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
    const m = l - c / 2;
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/**
 * The field of strands.
 *
 * Same shape as the room background: a base sine plus a second harmonic at 1.7x the
 * frequency and 0.28x the amplitude, which is what stops the curve ever exactly repeating.
 * Brightness falls off with distance from the curve, so each strand carries its own glow
 * without needing a blur pass.
 */
function strandField(width, height, { strands = 4, spread = 0.72, thickness = 2.1, glow = 9 } = {}) {
    const lam = width * 0.55;
    const k = (2 * Math.PI) / lam;

    return (x, y) => {
        const t = height <= 1 ? 0 : y / (height - 1);
        let colour = mix(BG_TOP, BG_BOTTOM, t);

        for (let s = 0; s < strands; s++) {
            const spacing = (height * spread) / strands;
            const baseY = height * ((1 - spread) / 2) + (s + 0.5) * spacing;
            const phase = s * 0.85;
            const amp = spacing * 0.92;

            const curveY = baseY
                + amp * 0.9 * Math.sin(k * x + phase)
                + amp * 0.28 * Math.sin(k * 1.7 * x + phase * 1.4);

            const d = Math.abs(y - curveY);
            const core = Math.max(0, 1 - d / thickness);
            const halo = Math.max(0, 1 - d / glow) ** 2;

            const [r, g, b] = hsl(STRAND_HUES[s % STRAND_HUES.length], 0.8, 0.62);
            colour = mix(colour, [r, g, b], Math.min(1, halo * 0.4));
            colour = mix(colour, [255, 255, 255], core * 0.85);
        }
        return colour.map(clamp);
    };
}

mkdirSync(OUT, { recursive: true });

// Fixed by NSIS. Neither size is negotiable.
const sidebar = writeBmp(join(OUT, 'installerSidebar.bmp'), 164, 314,
    strandField(164, 314, { strands: 5, spread: 0.78, thickness: 1.9, glow: 10 }));

const header = writeBmp(join(OUT, 'installerHeader.bmp'), 150, 57,
    strandField(150, 57, { strands: 2, spread: 0.55, thickness: 1.6, glow: 6 }));

// The uninstaller gets the same sidebar: it is the same product, and a different picture
// there reads as a different program asking to remove your files.
const uninstall = writeBmp(join(OUT, 'uninstallerSidebar.bmp'), 164, 314,
    strandField(164, 314, { strands: 5, spread: 0.78, thickness: 1.9, glow: 10 }));

console.log(`installerSidebar.bmp    164x314  ${sidebar} bytes`);
console.log(`installerHeader.bmp     150x57   ${header} bytes`);
console.log(`uninstallerSidebar.bmp  164x314  ${uninstall} bytes`);
