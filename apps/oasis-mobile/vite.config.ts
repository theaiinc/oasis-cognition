import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

export default defineConfig({
  define: {
    __BUILD_NUMBER__: JSON.stringify(
      `m-${new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '')}`
    ),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        skipWaiting: true,
        clientsClaim: true,
        // API calls pass through to network — never cache them
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/pair/, /^\/relay/, /^\/health/],
      },
      manifest: {
        name: 'Oasis Mobile',
        short_name: 'Oasis',
        description: 'Oasis Cognition Mobile Companion',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        theme_color: '#0a0f1a',
        background_color: '#0a0f1a',
        icons: [
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icons/icon-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'maskable' },
          { src: '/icons/icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@oasis/ui-kit': path.resolve(__dirname, '../../packages/ui-kit/src'),
    },
  },
});
