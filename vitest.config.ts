import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['infra', 'server', 'shared', 'web'],
    passWithNoTests: true,
  },
});
