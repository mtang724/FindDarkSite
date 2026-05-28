import { defineConfig } from 'vite';

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
});
