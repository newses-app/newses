import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['desktop', 'infra', 'mobile', 'server', 'shared', 'web'],
    passWithNoTests: true,
  },
});
