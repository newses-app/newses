// Builds the desktop app into out/: the main process and preload bundles, the native web build,
// and the window icon. `--skip-web` keeps the web build out (the dev server serves it instead).
import { spawnSync } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}out`;
const web = fileURLToPath(new URL('../../web/', import.meta.url));

await rm(out, { recursive: true, force: true });
await mkdir(`${root}build`, { recursive: true });

if (!process.argv.includes('--skip-web')) {
  const result = spawnSync('pnpm', ['--filter', '@rss-reader/web', 'build:native'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  await cp(`${web}dist-native`, `${out}/web`, { recursive: true });
}

// Sandboxed preloads must be single CommonJS files; the main process uses the same format.
await build({
  entryPoints: { main: `${root}src/main.ts`, preload: `${root}src/preload.ts` },
  outdir: out,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: 'linked',
  logLevel: 'warning',
});

// The window icon, and electron-builder's source for the installers' icons.
await cp(`${web}public/icon-512.png`, `${out}/icon.png`);
await cp(`${web}public/icon-512.png`, `${root}build/icon.png`);
