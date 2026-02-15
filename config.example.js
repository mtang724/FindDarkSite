// Copy this file to config.js and fill in your API keys
// DO NOT commit config.js to version control

export const CONFIG = {
    // Google Maps API key — enable "Places API (New)" + "Maps JavaScript API"
    // Get one at: https://console.cloud.google.com/apis/credentials
    GOOGLE_MAPS_API_KEY: 'YOUR_GOOGLE_MAPS_API_KEY',

    // Recreation.gov RIDB API key (free)
    // Register at: https://ridb.recreation.gov/docs
    RIDB_API_KEY: 'YOUR_RIDB_API_KEY',

    // Default search settings
    DEFAULT_RADIUS_KM: 150,
    DEFAULT_MIN_SQM: 20.5,
    DEFAULT_GRID_STEP_KM: 5,
    DEFAULT_MAX_RESULTS: 25,
    POI_SEARCH_RADIUS_M: 8000, // 8 km radius for POI search around each seed
};
