/**
 * Favorites export/import and share-link helpers.
 *
 * Share link format:    #site=<lat>,<lng>[,<sqm>]
 * Export file format:   { version: 1, exportedAt: ISO, favorites: [...] }
 */

const FAVORITES_KEY = 'darksite-favorites';
const EXPORT_VERSION = 1;

export function exportFavorites(favorites) {
    const blob = new Blob(
        [JSON.stringify({ version: EXPORT_VERSION, exportedAt: new Date().toISOString(), favorites }, null, 2)],
        { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `darksite-favorites-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

/**
 * Parse + merge an uploaded favorites file. Skips duplicates by lat/lng.
 * @returns {{ added: number, skipped: number, favorites: Array }}
 */
export async function importFavorites(file, existing) {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const incoming = Array.isArray(parsed) ? parsed : parsed.favorites;
    if (!Array.isArray(incoming)) throw new Error('Not a valid favorites file');

    const merged = [...existing];
    let added = 0, skipped = 0;
    const seen = new Set(merged.map(f => `${f.lat},${f.lng}`));
    for (const fav of incoming) {
        if (typeof fav?.lat !== 'number' || typeof fav?.lng !== 'number') {
            skipped++;
            continue;
        }
        const key = `${fav.lat},${fav.lng}`;
        if (seen.has(key)) { skipped++; continue; }
        seen.add(key);
        merged.push(fav);
        added++;
    }
    return { added, skipped, favorites: merged };
}

export function siteShareUrl(site) {
    const parts = [site.lat.toFixed(5), site.lng.toFixed(5)];
    if (site.sqm != null) parts.push(site.sqm.toFixed(2));
    const url = new URL(window.location.href);
    url.hash = `site=${parts.join(',')}`;
    return url.toString();
}

/**
 * Parse `#site=lat,lng[,sqm]` out of the current URL. Returns null if absent
 * or malformed.
 */
export function parseSharedSite(hash = window.location.hash) {
    if (!hash || hash[0] !== '#') return null;
    const m = hash.slice(1).match(/^site=(-?\d+\.?\d*),(-?\d+\.?\d*)(?:,(-?\d+\.?\d*))?$/);
    if (!m) return null;
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    const sqm = m[3] != null ? parseFloat(m[3]) : null;
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return { lat, lng, sqm };
}

export async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Fallback for non-secure contexts
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch { /* nope */ }
        ta.remove();
        return false;
    }
}
