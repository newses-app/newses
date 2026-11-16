import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

/**
 * Entrypoints and scripts that only wire tested modules together and run as they load, so no
 * test imports them. Each is named, so a new file is covered until it is shown to be wiring
 * only; move any logic out before adding a file here.
 */
const STARTUP_WIRING = [
  'server/src/entrypoints/{server,cli,migrate,worker}.ts',
  'server/src/entrypoints/lambda/{api,extract,favicon,fetch,migrate,tick}.ts',
  'server/src/telemetry/{sdk,register}.ts',
  'infra/src/main.ts',
  'infra/src/release/{build-openapi,build-sbom,publish,publish-image,upload-sbom}.ts',
  'shared/src/{coverage,locale}-status.ts',
  'web/src/main.ts',
  'web/src/worker/sw.ts',
  'desktop/src/{main,preload}.ts',
  'mobile/src/bridge.ts',
];

export default defineConfig({
  test: {
    projects: ['desktop', 'infra', 'mobile', 'plugin-api', 'server', 'shared', 'web'],
    passWithNoTests: true,
    // The pipeline's vCPUs (CodeBuild ARM LARGE); more workers starve the server's database tests,
    // which share the cores with Postgres.
    maxWorkers: Math.min(8, availableParallelism()),
    // On with `--coverage` (`pnpm test:coverage`). Projects cannot set their own, so one report
    // covers every package; `pnpm coverage:status` splits it per package.
    coverage: {
      provider: 'v8',
      // Files no test imports count too, at 0%.
      include: ['{desktop,infra,mobile,plugin-api,server,shared,web}/src/**/*.{ts,vue}'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '*/src/test/**', ...STARTUP_WIRING],
      // LCOV for Sonar, HTML to browse, the JSON summary for `pnpm coverage:status`.
      reporter: ['text-summary', 'json-summary', 'lcov', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
