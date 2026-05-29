/**
 * Top 50 US metros — name, primary subreddit(s), center lat/lng, broad region.
 * Used by scripts/fetch-reddit-stargazing.mjs to enumerate Reddit searches and
 * by main.js to pick the closest metro for a user's resolved location.
 *
 * Center coords are the metro core (downtown), not the MSA centroid — that's
 * what people search "from" when they type a city name.
 *
 * For each metro we ship:
 *   subreddits   — city sub + any obvious neighborhood/area sub
 *   region       — the broader regional sub (state, area) that catches threads
 *                  the city sub doesn't (e.g. r/CentralTexas for Austin)
 *   state        — 2-letter state code (also used as a state-sub fallback)
 *
 * The scraper additionally hits NATIONAL_SUBS (below) with each metro's
 * city name + "stargazing" so threads on r/astrophotography that drop a
 * Boston-area spot get associated with Boston.
 */

export const US_METROS = [
    { city: 'New York',        state: 'NY', lat: 40.7128, lng:  -74.0060, subreddits: ['nyc', 'AskNYC'],          region: 'newyork' },
    { city: 'Los Angeles',     state: 'CA', lat: 34.0522, lng: -118.2437, subreddits: ['LosAngeles', 'AskLosAngeles'], region: 'California' },
    { city: 'Chicago',         state: 'IL', lat: 41.8781, lng:  -87.6298, subreddits: ['chicago'],                region: 'illinois' },
    { city: 'Dallas',          state: 'TX', lat: 32.7767, lng:  -96.7970, subreddits: ['Dallas', 'dfw'],          region: 'texas' },
    { city: 'Houston',         state: 'TX', lat: 29.7604, lng:  -95.3698, subreddits: ['houston'],                region: 'texas' },
    { city: 'Atlanta',         state: 'GA', lat: 33.7490, lng:  -84.3880, subreddits: ['Atlanta'],                region: 'Georgia' },
    { city: 'Washington',      state: 'DC', lat: 38.9072, lng:  -77.0369, subreddits: ['washingtondc', 'nova'],   region: 'Virginia' },
    { city: 'Philadelphia',    state: 'PA', lat: 39.9526, lng:  -75.1652, subreddits: ['philadelphia'],           region: 'Pennsylvania' },
    { city: 'Miami',           state: 'FL', lat: 25.7617, lng:  -80.1918, subreddits: ['Miami'],                  region: 'florida' },
    { city: 'Phoenix',         state: 'AZ', lat: 33.4484, lng: -112.0740, subreddits: ['phoenix'],                region: 'arizona' },
    { city: 'Boston',          state: 'MA', lat: 42.3601, lng:  -71.0589, subreddits: ['boston'],                 region: 'massachusetts' },
    { city: 'Riverside',       state: 'CA', lat: 33.9533, lng: -117.3962, subreddits: ['InlandEmpire'],           region: 'California' },
    { city: 'San Francisco',   state: 'CA', lat: 37.7749, lng: -122.4194, subreddits: ['sanfrancisco', 'bayarea'], region: 'California' },
    { city: 'Detroit',         state: 'MI', lat: 42.3314, lng:  -83.0458, subreddits: ['Detroit'],                region: 'Michigan' },
    { city: 'Seattle',         state: 'WA', lat: 47.6062, lng: -122.3321, subreddits: ['Seattle', 'SeattleWA'],   region: 'WashingtonState' },
    { city: 'Minneapolis',     state: 'MN', lat: 44.9778, lng:  -93.2650, subreddits: ['Minneapolis', 'TwinCities'], region: 'minnesota' },
    { city: 'San Diego',       state: 'CA', lat: 32.7157, lng: -117.1611, subreddits: ['sandiego'],               region: 'California' },
    { city: 'Tampa',           state: 'FL', lat: 27.9506, lng:  -82.4572, subreddits: ['tampa', 'StPetersburgFL'],region: 'florida' },
    { city: 'Denver',          state: 'CO', lat: 39.7392, lng: -104.9903, subreddits: ['Denver'],                 region: 'Colorado' },
    { city: 'Baltimore',       state: 'MD', lat: 39.2904, lng:  -76.6122, subreddits: ['baltimore'],              region: 'maryland' },
    { city: 'St. Louis',       state: 'MO', lat: 38.6270, lng:  -90.1994, subreddits: ['StLouis'],                region: 'missouri' },
    { city: 'Orlando',         state: 'FL', lat: 28.5383, lng:  -81.3792, subreddits: ['orlando'],                region: 'florida' },
    { city: 'Charlotte',       state: 'NC', lat: 35.2271, lng:  -80.8431, subreddits: ['Charlotte'],              region: 'NorthCarolina' },
    { city: 'San Antonio',     state: 'TX', lat: 29.4241, lng:  -98.4936, subreddits: ['sanantonio'],             region: 'texas' },
    { city: 'Portland',        state: 'OR', lat: 45.5152, lng: -122.6784, subreddits: ['Portland', 'askportland'], region: 'oregon' },
    { city: 'Sacramento',      state: 'CA', lat: 38.5816, lng: -121.4944, subreddits: ['Sacramento'],             region: 'California' },
    { city: 'Pittsburgh',      state: 'PA', lat: 40.4406, lng:  -79.9959, subreddits: ['pittsburgh'],             region: 'Pennsylvania' },
    { city: 'Las Vegas',       state: 'NV', lat: 36.1699, lng: -115.1398, subreddits: ['vegas', 'LasVegas'],      region: 'Nevada' },
    { city: 'Austin',          state: 'TX', lat: 30.2672, lng:  -97.7431, subreddits: ['Austin', 'CentralTexas'], region: 'texas' },
    { city: 'Cincinnati',      state: 'OH', lat: 39.1031, lng:  -84.5120, subreddits: ['cincinnati'],             region: 'Ohio' },
    { city: 'Kansas City',     state: 'MO', lat: 39.0997, lng:  -94.5786, subreddits: ['kansascity'],             region: 'missouri' },
    { city: 'Columbus',        state: 'OH', lat: 39.9612, lng:  -82.9988, subreddits: ['Columbus'],               region: 'Ohio' },
    { city: 'Indianapolis',    state: 'IN', lat: 39.7684, lng:  -86.1581, subreddits: ['Indianapolis', 'indiana'],region: 'Indiana' },
    { city: 'Cleveland',       state: 'OH', lat: 41.4993, lng:  -81.6944, subreddits: ['Cleveland'],              region: 'Ohio' },
    { city: 'Nashville',       state: 'TN', lat: 36.1627, lng:  -86.7816, subreddits: ['nashville'],              region: 'Tennessee' },
    { city: 'San Jose',        state: 'CA', lat: 37.3382, lng: -121.8863, subreddits: ['SanJose'],                region: 'California' },
    { city: 'Virginia Beach',  state: 'VA', lat: 36.8529, lng:  -75.9780, subreddits: ['VirginiaBeach', 'HamptonRoads'], region: 'Virginia' },
    { city: 'Providence',      state: 'RI', lat: 41.8240, lng:  -71.4128, subreddits: ['Providence', 'RhodeIsland'], region: 'newengland' },
    { city: 'Jacksonville',    state: 'FL', lat: 30.3322, lng:  -81.6557, subreddits: ['jacksonville'],           region: 'florida' },
    { city: 'Milwaukee',       state: 'WI', lat: 43.0389, lng:  -87.9065, subreddits: ['milwaukee'],              region: 'wisconsin' },
    { city: 'Oklahoma City',   state: 'OK', lat: 35.4676, lng:  -97.5164, subreddits: ['oklahomacity'],           region: 'oklahoma' },
    { city: 'Raleigh',         state: 'NC', lat: 35.7796, lng:  -78.6382, subreddits: ['raleigh', 'triangle'],    region: 'NorthCarolina' },
    { city: 'Memphis',         state: 'TN', lat: 35.1495, lng:  -90.0490, subreddits: ['memphis'],                region: 'Tennessee' },
    { city: 'Richmond',        state: 'VA', lat: 37.5407, lng:  -77.4360, subreddits: ['rva'],                    region: 'Virginia' },
    { city: 'Louisville',      state: 'KY', lat: 38.2527, lng:  -85.7585, subreddits: ['Louisville'],             region: 'Kentucky' },
    { city: 'New Orleans',     state: 'LA', lat: 29.9511, lng:  -90.0715, subreddits: ['NewOrleans'],             region: 'Louisiana' },
    { city: 'Salt Lake City',  state: 'UT', lat: 40.7608, lng: -111.8910, subreddits: ['SaltLakeCity', 'Utah'],   region: 'Utah' },
    { city: 'Hartford',        state: 'CT', lat: 41.7637, lng:  -72.6850, subreddits: ['Hartford', 'Connecticut'],region: 'newengland' },
    { city: 'Birmingham',      state: 'AL', lat: 33.5186, lng:  -86.8104, subreddits: ['Birmingham'],             region: 'alabama' },
    { city: 'Buffalo',         state: 'NY', lat: 42.8864, lng:  -78.8784, subreddits: ['Buffalo'],                region: 'newyork' },
];

/**
 * National subreddits where stargazing-related posts often mention a specific
 * spot near a city. We search each of these with `q="<city>" stargazing` to
 * pull metro-relevant threads from outside the city sub.
 */
export const NATIONAL_SUBS = [
    'astrophotography',
    'AmateurAstronomy',
    'AskAstronomy',
    'CampingandHiking',
    'NationalParks',
    'darksky',
];

/**
 * Search query variants to fan out the in-city searches.
 * "stargazing" is the obvious one; the others catch posts that don't use
 * that exact word.
 */
export const CITY_SEARCH_QUERIES = [
    'stargazing',
    'dark sky',
    'milky way',
];

// ───────────────────────────────────────────────────────────────────────────
// Extras used only by scripts/fetch-reddit-deep.mjs — kept separate so the
// existing wide / slow scrapers retain their original behavior exactly.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Mid-size cities specifically chosen for proximity to genuinely dark regions
 * (national parks, BLM, mountain ranges, IDA-certified areas). The original
 * US_METROS is "biggest 50 by population"; this list is "best 35 by sky access".
 */
export const EXTRA_METROS = [
    { city: 'Tucson',         state: 'AZ', lat: 32.2226, lng: -110.9747, subreddits: ['Tucson'],                    region: 'arizona' },
    { city: 'Flagstaff',      state: 'AZ', lat: 35.1983, lng: -111.6513, subreddits: ['flagstaff'],                 region: 'arizona' },
    { city: 'Sedona',         state: 'AZ', lat: 34.8697, lng: -111.7610, subreddits: ['Sedona'],                    region: 'arizona' },
    { city: 'Albuquerque',    state: 'NM', lat: 35.0844, lng: -106.6504, subreddits: ['Albuquerque'],               region: 'NewMexico' },
    { city: 'Santa Fe',       state: 'NM', lat: 35.6870, lng: -105.9378, subreddits: ['SantaFe'],                   region: 'NewMexico' },
    { city: 'Las Cruces',     state: 'NM', lat: 32.3199, lng: -106.7637, subreddits: ['LasCruces'],                 region: 'NewMexico' },
    { city: 'Reno',           state: 'NV', lat: 39.5296, lng: -119.8138, subreddits: ['Reno'],                      region: 'Nevada' },
    { city: 'Boise',          state: 'ID', lat: 43.6150, lng: -116.2023, subreddits: ['Boise'],                     region: 'Idaho' },
    { city: 'El Paso',        state: 'TX', lat: 31.7619, lng: -106.4850, subreddits: ['ElPaso'],                    region: 'texas' },
    { city: 'Bend',           state: 'OR', lat: 44.0582, lng: -121.3153, subreddits: ['Bend'],                      region: 'oregon' },
    { city: 'Eugene',         state: 'OR', lat: 44.0521, lng: -123.0868, subreddits: ['Eugene'],                    region: 'oregon' },
    { city: 'Spokane',        state: 'WA', lat: 47.6588, lng: -117.4260, subreddits: ['Spokane'],                   region: 'WashingtonState' },
    { city: 'Bozeman',        state: 'MT', lat: 45.6770, lng: -111.0429, subreddits: ['Bozeman'],                   region: 'Montana' },
    { city: 'Missoula',       state: 'MT', lat: 46.8721, lng: -113.9940, subreddits: ['missoula'],                  region: 'Montana' },
    { city: 'Billings',       state: 'MT', lat: 45.7833, lng: -108.5007, subreddits: ['billings'],                  region: 'Montana' },
    { city: 'Helena',         state: 'MT', lat: 46.5891, lng: -112.0391, subreddits: ['Helena'],                    region: 'Montana' },
    { city: 'Cheyenne',       state: 'WY', lat: 41.1400, lng: -104.8202, subreddits: ['cheyenne'],                  region: 'wyoming' },
    { city: 'Casper',         state: 'WY', lat: 42.8666, lng: -106.3131, subreddits: ['casperwyoming'],             region: 'wyoming' },
    { city: 'Moab',           state: 'UT', lat: 38.5733, lng: -109.5498, subreddits: ['moab'],                      region: 'Utah' },
    { city: 'St. George',     state: 'UT', lat: 37.0965, lng: -113.5684, subreddits: ['StGeorge'],                  region: 'Utah' },
    { city: 'Anchorage',      state: 'AK', lat: 61.2181, lng: -149.9003, subreddits: ['anchorage', 'alaska'],       region: 'alaska' },
    { city: 'Fairbanks',      state: 'AK', lat: 64.8378, lng: -147.7164, subreddits: ['Fairbanks'],                 region: 'alaska' },
    { city: 'Honolulu',       state: 'HI', lat: 21.3099, lng: -157.8581, subreddits: ['Hawaii'],                    region: 'Hawaii' },
    { city: 'Asheville',      state: 'NC', lat: 35.5951, lng:  -82.5515, subreddits: ['asheville'],                 region: 'NorthCarolina' },
    { city: 'Knoxville',      state: 'TN', lat: 35.9606, lng:  -83.9207, subreddits: ['Knoxville'],                 region: 'Tennessee' },
    { city: 'Lexington',      state: 'KY', lat: 38.0406, lng:  -84.5037, subreddits: ['lexington'],                 region: 'Kentucky' },
    { city: 'Madison',        state: 'WI', lat: 43.0731, lng:  -89.4012, subreddits: ['madisonwi'],                 region: 'wisconsin' },
    { city: 'Des Moines',     state: 'IA', lat: 41.5868, lng:  -93.6250, subreddits: ['desmoines', 'Iowa'],         region: 'Iowa' },
    { city: 'Omaha',          state: 'NE', lat: 41.2565, lng:  -95.9345, subreddits: ['Omaha'],                     region: 'Nebraska' },
    { city: 'Wichita',        state: 'KS', lat: 37.6872, lng:  -97.3301, subreddits: ['wichita'],                   region: 'Kansas' },
    { city: 'Tulsa',          state: 'OK', lat: 36.1540, lng:  -95.9928, subreddits: ['tulsa'],                     region: 'oklahoma' },
    { city: 'Little Rock',    state: 'AR', lat: 34.7465, lng:  -92.2896, subreddits: ['LittleRock', 'Arkansas'],    region: 'Arkansas' },
    { city: 'Fargo',          state: 'ND', lat: 46.8772, lng:  -96.7898, subreddits: ['FargoFM'],                   region: 'northdakota' },
    { city: 'Sioux Falls',    state: 'SD', lat: 43.5460, lng:  -96.7313, subreddits: ['SiouxFalls'],                region: 'SouthDakota' },
    { city: 'Rapid City',     state: 'SD', lat: 44.0805, lng: -103.2310, subreddits: ['RapidCity'],                 region: 'SouthDakota' },
];

/** Additional astronomy-focused national subs for the deep sweep. */
export const EXTRA_NATIONAL_SUBS = [
    'stargazing',
    'Astronomy',
    'telescopes',
    'NightPhotography',
];

/** Extra query phrases beyond the original 3. */
export const EXTRA_QUERIES = [
    'observatory',
    'telescope',
    'night sky',
];
