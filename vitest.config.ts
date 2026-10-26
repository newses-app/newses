import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['desktop', 'infra', 'mobile', 'server', 'shared', 'web'],
    passWithNoTests: true,
    // The pipeline's vCPUs (CodeBuild ARM LARGE); more workers starve the server's database tests,
    // which share the cores with Postgres.
    maxWorkers: Math.min(8, availableParallelism()),
  },
});
