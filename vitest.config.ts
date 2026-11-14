import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['desktop', 'infra', 'mobile', 'server', 'shared', 'web'],
    passWithNoTests: true,
    // The pipeline's vCPUs (CodeBuild ARM LARGE); more workers starve the server's database tests,
    // which share the cores with Postgres.
    maxWorkers: Math.min(8, availableParallelism()),
    // On with `--coverage` (`pnpm test:coverage`). Projects cannot set their own, so one report
    // covers every package; `pnpm coverage:status` splits it per package.
    coverage: {
      provider: 'v8',
      // Files no test imports count too, at 0%.
      include: ['{desktop,infra,mobile,server,shared,web}/src/**/*.{ts,vue}'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '*/src/test/**'],
      // LCOV for Sonar, HTML to browse, the JSON summary for `pnpm coverage:status`.
      reporter: ['text-summary', 'json-summary', 'lcov', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
