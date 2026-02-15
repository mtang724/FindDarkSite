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
        },
    },
});
