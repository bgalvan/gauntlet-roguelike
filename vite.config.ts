import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env['GITHUB_PAGES'] ? '/gauntlet-roguelike/' : '/',
  server: { port: 5173, open: false },
  build: { target: 'es2022', sourcemap: true },
});
