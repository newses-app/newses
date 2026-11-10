// Builds the Android app's web assets into www/ and syncs them into android/:
// the native web build, with the platform bridge (www/bridge.js) loaded ahead of the app, and the
// licences of what the bridge and the native plugins add to it (the Android libraries with an APK).
// `--apk debug|release` then builds the APK into release/; `--install` also installs it with adb.
// The version comes from RELEASE_TAG (e.g. v1.2.3); local builds are 0.0.0-dev.
// Release APKs are signed with the ANDROID_KEYSTORE_* values, from the environment or
// android-signing.env (scripts/android-signing-setup.sh); without them they are unsigned.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PLATFORM_LICENSES_FILE, type ThirdPartyLicense } from '@newses/shared/client';
import { versionFromTag } from '@newses/shared/release';
import {
  checkLicenses,
  mavenLicenses,
  mergeLicenses,
  packageLicenses,
} from '@newses/shared/third-party-licenses';
import { build } from 'esbuild';

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

run('pnpm', ['--filter', '@newses/web', 'build:native']);
await rm(www, { recursive: true, force: true });
await cp(`${web}dist-native`, www, { recursive: true });

const bridge = await build({
  entryPoints: [`${root}src/bridge.ts`],
  outfile: `${www}/bridge.js`,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  define: {
    APP_VERSION: JSON.stringify(version.name),
    // Set by the release pipeline to the stage's downloads; local builds never update.
    DOWNLOADS_URL: JSON.stringify(process.env.DOWNLOADS_URL?.replace(/\/$/, '') ?? ''),
  },
  minify: true,
  metafile: true,
  logLevel: 'warning',
});
// The plugins' native code ships too, from the same packages.
const manifest = JSON.parse(await readFile(`${root}package.json`, 'utf8')) as {
  dependencies: Record<string, string>;
};
const plugins = Object.keys(manifest.dependencies)
  .filter((name) => !name.startsWith('@newses/'))
  .map((name) => `${root}node_modules/${name}/package.json`);
const writeLicenses = (dir: string, licenses: ThirdPartyLicense[]) =>
  writeFile(`${dir}/${PLATFORM_LICENSES_FILE}`, JSON.stringify(checkLicenses(licenses)));
const licenses = packageLicenses([...Object.keys(bridge.metafile.inputs), ...plugins]);
await writeLicenses(www, licenses);
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
  const envFile = `${root}android-signing.env`;
  if (variant === 'release' && !process.env.ANDROID_KEYSTORE_FILE && existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  const signed = variant === 'release' && Boolean(process.env.ANDROID_KEYSTORE_FILE);
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  // The Android libraries, from the SBOM of what the release APK links; written past the sync.
  run(gradlew, ['-q', ':app:cyclonedxDirectBom'], { cwd: `${root}android` });
  const bom = await readFile(`${root}android/app/build/reports/cyclonedx-direct/bom.json`, 'utf8');
  const all = mergeLicenses(
    licenses,
    mavenLicenses(JSON.parse(bom) as Parameters<typeof mavenLicenses>[0]),
  );
  await writeLicenses(www, all);
  await writeLicenses(`${root}android/app/src/main/assets/public`, all);
  const task = variant === 'debug' ? 'assembleDebug' : 'assembleRelease';
  run(gradlew, [task], {
    cwd: `${root}android`,
    env: { ...process.env, VERSION_NAME: version.name, VERSION_CODE: String(version.code) },
  });
  // Gradle names an unsigned release APK app-release-unsigned.apk.
  const unsigned = variant === 'release' && !signed ? '-unsigned' : '';
  const built = `${root}android/app/build/outputs/apk/${variant}/app-${variant}${unsigned}.apk`;
  const suffix = variant === 'debug' ? '-debug' : unsigned;
  const apk = `${root}release/newses-${version.name}-android${suffix}.apk`;
  await mkdir(`${root}release`, { recursive: true });
  await copyFile(built, apk);
  console.log(`Built ${apk}`);
  if (values.install) run('adb', ['install', '-r', apk]);
}
