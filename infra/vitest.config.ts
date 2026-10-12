import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Synthesising every stack takes a few seconds.
    testTimeout: 60_000,
    // Tests synthesise against the example, never a real deployment's config.
    env: {
      NEWSES_DEPLOY_CONFIG: fileURLToPath(new URL('deploy.config.example.json', import.meta.url)),
    },
  },
});
