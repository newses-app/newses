// Builds the Android app's web assets into www/ and syncs them into android/:
// the native web build, with the platform bridge (www/bridge.js) loaded ahead of the app.
// `--apk debug|release` then builds the APK into release/; `--install` also installs it with adb.
// The version comes from RELEASE_TAG (e.g. v1.2.3); local builds are 0.0.0-dev.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { versionFromTag } from '../src/version.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const web = fileURLToPath(new URL('../../web/', import.meta.url));
const www = `${root}www`;
const { values } = parseArgs({
  options: { apk: { type: 'string' }, install: { type: 'boolean', default: false } },
});
const variant = values.apk;
if (variant !== undefined && variant !== 'debug' && variant !== 'release') {
  throw new Error('--apk takes debug or release');
}
const version = versionFromTag(process.env.RELEASE_TAG);

function run(command: string, args: string[], options: SpawnSyncOptions = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('pnpm', ['--filter', '@rss-reader/web', 'build:native']);
await rm(www, { recursive: true, force: true });
await cp(`${web}dist-native`, www, { recursive: true });

await build({
  entryPoints: [`${root}src/bridge.ts`],
  outfile: `${www}/bridge.js`,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  define: { APP_VERSION: JSON.stringify(version.name) },
  minify: true,
  logLevel: 'warning',
});
// A classic script runs while the page is parsed, before the app's deferred module scripts.
const index = `${www}/index.html`;
const html = await readFile(index, 'utf8');
if (!html.includes('<script type="module"')) throw new Error('No module script in index.html');
await writeFile(
  index,
  html.replace(
    '<script type="module"',
    '<script src="/bridge.js"></script>\n    <script type="module"',
  ),
);

run('pnpm', ['exec', 'cap', 'sync', 'android'], { cwd: root });

if (variant) {
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  const task = variant === 'debug' ? 'assembleDebug' : 'assembleRelease';
  run(gradlew, [task], {
    cwd: `${root}android`,
    env: { ...process.env, VERSION_NAME: version.name, VERSION_CODE: String(version.code) },
  });
  const suffix = variant === 'debug' ? '-debug' : '';
  // Unsigned release builds are named so by Gradle; the signed one (#59) drops the suffix.
  const built = `${root}android/app/build/outputs/apk/${variant}/app-${variant}.apk`;
  const apk = `${root}release/rss-reader-${version.name}-android${suffix}.apk`;
  await mkdir(`${root}release`, { recursive: true });
  await copyFile(built, apk);
  console.log(`Built ${apk}`);
  if (values.install) run('adb', ['install', '-r', apk]);
}
