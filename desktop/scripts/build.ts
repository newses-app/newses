// Builds the desktop app into out/: the main process and preload bundles, the native web build,
// the licences of what the bundles and Electron add to it, and the window icon. `--skip-web` keeps the web build out (the dev server serves it instead).
import { spawnSync } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PLATFORM_LICENSES_FILE } from '@newses/shared/client';
import { checkLicenses, packageLicenses } from '@newses/shared/third-party-licenses';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}out`;
const web = fileURLToPath(new URL('../../web/', import.meta.url));

await rm(out, { recursive: true, force: true });
await mkdir(`${root}build`, { recursive: true });

if (!process.argv.includes('--skip-web')) {
  const result = spawnSync('pnpm', ['--filter', '@newses/web', 'build:native'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  await cp(`${web}dist-native`, `${out}/web`, { recursive: true });
}

// Sandboxed preloads must be single CommonJS files; the main process uses the same format.
const bundles = await build({
  entryPoints: { main: `${root}src/main.ts`, preload: `${root}src/preload.ts` },
  outdir: out,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: 'linked',
  metafile: true,
  logLevel: 'warning',
});

// Electron ships its own and Chromium's licence files (LICENSE.electron.txt, LICENSES.chromium.html)
// beside the app; Help → Licenses opens Chromium's.
await mkdir(`${out}/web`, { recursive: true });
await writeFile(
  `${out}/web/${PLATFORM_LICENSES_FILE}`,
  JSON.stringify(
    checkLicenses(
      packageLicenses([
        ...Object.keys(bundles.metafile.inputs),
        `${root}node_modules/electron/package.json`,
      ]),
    ),
  ),
);

// The window icon, and electron-builder's source for the Linux icons. Windows uses the committed
// resources/icon.ico; regenerate it when the icon changes:
//   convert web/public/icon-512.png -define icon:auto-resize=256,128,64,48,32,16 desktop/resources/icon.ico
await cp(`${web}public/icon-512.png`, `${out}/icon.png`);
await cp(`${web}public/icon-512.png`, `${root}build/icon.png`);
