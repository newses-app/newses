import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { THIRD_PARTY_LICENSES_FILE, type ThirdPartyLicense } from '@newses/shared/client';
import { checkLicenses, mergeLicenses, packageLicenses } from '@newses/shared/third-party-licenses';
import { NATIVE_CSP } from '@newses/shared/web-csp';
import vue from '@vitejs/plugin-vue';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import vuetify from 'vite-plugin-vuetify';

const PWA_REGISTER = 'virtual:pwa-register';
// Forks name their own; the apps link their source from it (AGPL).
const { repository } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { repository: { url: string } };

/**
 * The apps' build: no service worker (the shells bundle the app, so there is nothing to cache or
 * update), and the native CSP in a `<meta>`, since nothing serves headers with the bundled files.
 */
function nativeShell(): Plugin {
  const stub = `\0${PWA_REGISTER}`;
  return {
    name: 'newses-native',
    resolveId: (id) => (id === PWA_REGISTER ? stub : null),
    load: (id) => (id === stub ? 'export const registerSW = () => () => Promise.resolve();' : null),
    transformIndexHtml: (html, context) => ({
      // Android draws the app under the system bars; `env(safe-area-inset-*)` needs this.
      html: html.replace('initial-scale=1.0"', 'initial-scale=1.0, viewport-fit=cover"'),
      // Not in development, where the dev server's own scripts and websocket need more.
      tags: context.server
        ? []
        : [
            {
              tag: 'meta',
              attrs: { 'http-equiv': 'Content-Security-Policy', content: NATIVE_CSP },
              injectTo: 'head-prepend',
            },
          ],
    }),
  };
}

/**
 * Writes the licences of the packages the build bundles, for the About tab. The service worker's
 * build runs after the app's and adds its own to the same file.
 */
function thirdPartyLicenses({ append = false } = {}): Plugin {
  let root = '';
  return {
    name: 'newses-third-party-licenses',
    apply: 'build',
    configResolved: (config) => {
      root = config.root;
    },
    generateBundle(options, bundle) {
      // Code by its modules; fonts and other assets by the files they came from.
      const files = Object.values(bundle).flatMap((output) =>
        output.type === 'chunk'
          ? output.moduleIds
          : output.originalFileNames.map((name) => resolve(root, name)),
      );
      let licenses = packageLicenses(files);
      if (append && options.dir) {
        const app = JSON.parse(
          readFileSync(join(options.dir, THIRD_PARTY_LICENSES_FILE), 'utf8'),
        ) as ThirdPartyLicense[];
        licenses = mergeLicenses(app, licenses);
      }
      this.emitFile({
        type: 'asset',
        fileName: THIRD_PARTY_LICENSES_FILE,
        source: JSON.stringify(checkLicenses(licenses)),
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  build: { outDir: mode === 'native' ? 'dist-native' : 'dist' },
  define: { NEWSES_REPOSITORY: JSON.stringify(repository.url) },
  plugins: [
    vue(),
    vuetify({ autoImport: true }),
    thirdPartyLicenses(),
    mode === 'native'
      ? nativeShell()
      : VitePWA({
          registerType: 'autoUpdate',
          includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
          manifest: {
            name: 'Newses',
            short_name: 'Newses',
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
            // Installed, the app appears in the share sheet; `/share` offers the page to subscribe
            // to or publish.
            share_target: {
              action: '/share',
              method: 'GET',
              params: { title: 'title', text: 'text', url: 'url' },
            },
          },
          // The service worker is src/worker/sw.ts: the app shell, theme fonts, feed icons, and
          // background sync.
          strategies: 'injectManifest',
          srcDir: 'src/worker',
          filename: 'sw.ts',
          injectManifest: {
            // The app shell only: API responses are never cached.
            globPatterns: ['**/*.{js,css,html,svg,png}', THIRD_PARTY_LICENSES_FILE],
            buildPlugins: { vite: [thirdPartyLicenses({ append: true })] },
          },
        }),
  ],
  server: {
    proxy: { '/api': 'http://localhost:8080', '/favicons': 'http://localhost:8080' },
  },
}));
