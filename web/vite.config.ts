import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import vuetify from 'vite-plugin-vuetify';

export default defineConfig({
  plugins: [
    vue(),
    vuetify({ autoImport: true }),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'rss-reader',
        short_name: 'Reader',
        description: 'Self-hosted feed reader',
        theme_color: '#e8710a',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The app shell only: API responses are never cached (online-first).
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Paths the server answers itself (`NOT_SPA` in server/src/api/web.ts): public pages and
        // feeds, the native and compatibility APIs, and feed icons never get the app shell.
        navigateFallbackDenylist: [
          /^\/(api|public|healthz|accounts|reader|feed-icons)(\/|$)/,
          /^\/public\.php$/,
        ],
      },
    }),
  ],
  server: {
    proxy: { '/api': 'http://localhost:8080' },
  },
});
