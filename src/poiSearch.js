/**
 * POI Search module — Google Places API Nearby Search (New)
 */

const PLACES_API_URL = 'https://places.googleapis.com/v1/places:searchNearby';

// POI types relevant for dark-sky site accessibility
export const POI_CATEGORIES = {
    campground: { label: 'Campground', icon: '🏕️', types: ['campground'] },
    rv_park: { label: 'RV Park', icon: '🚐', types: ['rv_park'] },
    parking: { label: 'Parking', icon: '🅿️', types: ['parking'] },
    lodging: { label: 'Lodging', icon: '🏨', types: ['lodging'] },
    park: { label: 'Park', icon: '🌲', types: ['park', 'national_park'] },
    tourist_attraction: { label: 'Attraction', icon: '📍', types: ['tourist_attraction'] },
};

/**
 * Search for nearby POIs using Google Places API (New)
 * @param {string} apiKey - Google Maps API key
 * @param {number} lat - center latitude
 * @param {number} lng - center longitude
 * @param {number} radiusM - search radius in meters (max 50000)
 * @param {string[]} types - place types to search for
 * @returns {Array<{name, lat, lng, types, address, rating, placeId, distance}>}
 */
export async function searchNearbyPOIs(apiKey, lat, lng, radiusM = 8000, types = null) {
    if (!apiKey || apiKey === 'YOUR_GOOGLE_MAPS_API_KEY') {
        console.warn('Google Maps API key not configured');
        return [];
    }

    const allTypes = types || Object.values(POI_CATEGORIES).flatMap(c => c.types);
    const allResults = [];

    // Google Places API (New) allows up to 50 results per request
    // We search for each type category separately for better coverage
    for (const type of allTypes) {
        try {
            const body = {
                includedTypes: [type],
                maxResultCount: 20,
                locationRestriction: {
                    circle: {
                        center: { latitude: lat, longitude: lng },
                        radius: Math.min(radiusM, 50000)
                    }
                }
            };

            const resp = await fetch(PLACES_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': apiKey,
                    'X-Goog-FieldMask': 'places.displayName,places.location,places.types,places.formattedAddress,places.rating,places.id'
                },
                body: JSON.stringify(body)
            });

            if (!resp.ok) {
                console.warn(`Places API error for type ${type}: HTTP ${resp.status}`);
                continue;
            }

            const data = await resp.json();
            if (data.places) {
                for (const place of data.places) {
                    allResults.push({
                        name: place.displayName?.text || 'Unknown',
                        lat: place.location?.latitude,
                        lng: place.location?.longitude,
                        types: place.types || [type],
                        address: place.formattedAddress || '',
                        rating: place.rating || null,
                        placeId: place.id || null,
                        source: 'google'
                    });
                }
            }
        } catch (err) {
            console.warn(`Places API error for type ${type}:`, err.message);
        }
    }

    // Deduplicate by placeId
    const seen = new Set();
    return allResults.filter(r => {
        const key = r.placeId || `${r.lat},${r.lng}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Search for campgrounds via Recreation.gov RIDB API
 * @param {string} apiKey - RIDB API key
 * @param {number} lat - center latitude
 * @param {number} lng - center longitude
 * @param {number} radiusKm - search radius in km
 * @returns {Array}
 */
export async function searchRIDBCampgrounds(apiKey, lat, lng, radiusKm = 8) {
    if (!apiKey || apiKey === 'YOUR_RIDB_API_KEY') {
        console.warn('RIDB API key not configured');
        return [];
    }

    try {
        const radiusMiles = radiusKm * 0.621371;
        // Use Vite proxy in dev to avoid CORS; in production, use a server proxy
        const baseUrl = import.meta.env.DEV
            ? '/api/ridb'
            : 'https://ridb.recreation.gov/api/v1';
        const url = `${baseUrl}/facilities?latitude=${lat}&longitude=${lng}&radius=${radiusMiles}&activity=CAMPING&limit=50`;

        const resp = await fetch(url, {
            headers: {
                'apikey': apiKey,
                'Accept': 'application/json'
            }
        });

        if (!resp.ok) {
            console.warn(`RIDB API error: HTTP ${resp.status}`);
            return [];
        }

        const data = await resp.json();
        if (!data.RECDATA) return [];

        return data.RECDATA
            .filter(f => f.FacilityLatitude && f.FacilityLongitude)
            .map(f => ({
                name: f.FacilityName,
                lat: f.FacilityLatitude,
                lng: f.FacilityLongitude,
                types: ['campground'],
                address: `${f.FacilityAddressee || ''}, ${f.FacilityState || ''}`.trim(),
                description: f.FacilityDescription?.replace(/<[^>]*>/g, '').substring(0, 200) || '',
                reservationUrl: f.FacilityReservationURL || `https://www.recreation.gov/camping/campgrounds/${f.FacilityID}`,
                source: 'recreation.gov',
                placeId: `ridb_${f.FacilityID}`
            }));
    } catch (err) {
        console.warn('RIDB API error:', err.message);
        return [];
    }
}

/**
 * Get category info for a POI's types
 */
export function categorizePOI(types) {
    for (const [key, cat] of Object.entries(POI_CATEGORIES)) {
        if (types.some(t => cat.types.includes(t) || t === key)) {
            return cat;
        }
    }
    return { label: 'Place', icon: '📍' };
}
