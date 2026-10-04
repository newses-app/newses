import vue from '@vitejs/plugin-vue';
import vuetify from 'vite-plugin-vuetify';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue(), vuetify({ autoImport: true })],
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    server: { deps: { inline: ['vuetify'] } },
  },
});
