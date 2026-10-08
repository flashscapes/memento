import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { assetsInlineLimit: 60000, target: 'es2022' },
  server: {
    // `npm run dev` forwards the MP4 renderer's API to `npm start` (port 8787).
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        configure: (proxy) => proxy.on('proxyReq', (req) => req.removeHeader('origin')),
      },
    },
  },
});
