import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Synthesising every stack takes a few seconds.
    testTimeout: 60_000,
  },
});
