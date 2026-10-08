import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { assetsInlineLimit: 60000, target: 'es2022' },
});
