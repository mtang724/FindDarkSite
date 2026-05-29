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
