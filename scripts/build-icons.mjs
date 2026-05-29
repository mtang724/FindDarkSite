/**
 * Rasterize public/icons/icon.svg into PWA-required PNG sizes.
 * Run with: node scripts/build-icons.mjs
 */
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.join(__dirname, '..', 'public', 'icons');

const TARGETS = [
    { out: 'icon-192.png', size: 192 },
    { out: 'icon-512.png', size: 512 },
    // Maskable icon — same art, no padding adjustment needed since the SVG
    // already keeps the focal element well inside the safe zone.
    { out: 'icon-maskable.png', size: 512 },
    // Convenience favicon
    { out: 'favicon-32.png', size: 32 },
];

async function main() {
    const svg = await readFile(path.join(ICONS_DIR, 'icon.svg'));
    for (const { out, size } of TARGETS) {
        const buf = await sharp(svg)
            .resize(size, size, { fit: 'cover' })
            .png({ compressionLevel: 9 })
            .toBuffer();
        await writeFile(path.join(ICONS_DIR, out), buf);
        console.log(`✓ ${out} (${size}×${size}, ${buf.length} bytes)`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
