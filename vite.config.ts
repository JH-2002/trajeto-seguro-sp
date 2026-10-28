import { defineConfig } from 'vite';

export default defineConfig({
  // No GitHub Pages o site fica em /<nome-do-repositório>/; o workflow define BASE_PATH.
  base: process.env.BASE_PATH ?? '/',
  server: { port: 5173, open: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl'],
          deck: [
            '@deck.gl/core',
            '@deck.gl/layers',
            '@deck.gl/aggregation-layers',
            '@deck.gl/geo-layers',
            '@deck.gl/mapbox',
          ],
        },
      },
    },
  },
});
