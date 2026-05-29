import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
    server: {
        proxy: {
            // Proxy RIDB API calls to avoid CORS issues
            '/api/ridb': {
                target: 'https://ridb.recreation.gov',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/ridb/, '/api/v1'),
            },
            // Proxy lightpollutionmap.info GeoServer WMS for live scans
            '/api/lp': {
                target: 'https://www.lightpollutionmap.info',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/lp/, '/geoserver/gwc/service/wms'),
            },
        },
    },
    plugins: [
        VitePWA({
            registerType: 'autoUpdate',
            includeAssets: ['icons/icon.svg'],
            // The CONUS scan is 71 MB — keep the precache slim and rely on
            // runtime caching for big JSON.
            workbox: {
                // Default is 2 MB; bump so the main bundle fits comfortably.
                maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
                globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
                navigateFallback: 'index.html',
                runtimeCaching: [
                    // Pre-computed scan files — stale-while-revalidate so favorites still
                    // work offline after one successful load.
                    {
                        urlPattern: ({ url }) => url.pathname.startsWith('/data/') && url.pathname.endsWith('.json'),
                        handler: 'StaleWhileRevalidate',
                        options: {
                            cacheName: 'darksite-scans',
                            expiration: { maxEntries: 10, maxAgeSeconds: 30 * 24 * 60 * 60 },
                        },
                    },
                    // CARTO + Esri tiles — cache the tiles the user has already viewed.
                    {
                        urlPattern: ({ url }) => /basemaps\.cartocdn\.com|server\.arcgisonline\.com/.test(url.hostname),
                        handler: 'CacheFirst',
                        options: {
                            cacheName: 'darksite-tiles',
                            expiration: { maxEntries: 400, maxAgeSeconds: 30 * 24 * 60 * 60 },
                            cacheableResponse: { statuses: [0, 200] },
                        },
                    },
                    // Leaflet CSS pulled from unpkg.
                    {
                        urlPattern: ({ url }) => url.hostname === 'unpkg.com',
                        handler: 'StaleWhileRevalidate',
                        options: {
                            cacheName: 'darksite-vendor',
                            expiration: { maxEntries: 10, maxAgeSeconds: 30 * 24 * 60 * 60 },
                        },
                    },
                    // Google Fonts — let the browser cache as usual but make them work offline.
                    {
                        urlPattern: ({ url }) => /fonts\.(googleapis|gstatic)\.com/.test(url.hostname),
                        handler: 'CacheFirst',
                        options: {
                            cacheName: 'darksite-fonts',
                            expiration: { maxEntries: 20, maxAgeSeconds: 365 * 24 * 60 * 60 },
                            cacheableResponse: { statuses: [0, 200] },
                        },
                    },
                ],
            },
            manifest: {
                name: 'FindDarkSite — Dark Sky Site Finder',
                short_name: 'FindDarkSite',
                description: 'Find the best stargazing locations near you. Real VIIRS / World Atlas light-pollution data, nearby campgrounds and parks, cloud forecast, and horizon analysis.',
                theme_color: '#818cf8',
                background_color: '#0a0e1a',
                display: 'standalone',
                start_url: '/',
                scope: '/',
                orientation: 'any',
                icons: [
                    { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
                    { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
                    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
                    { src: 'icons/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
                ],
            },
        }),
    ],
});
