// Writes a deliverable's CycloneDX SBOM (sbom.ts) to DIR/newses-<version>-<deliverable>.cdx.json,
// for scripts/sbom.sh and the release pipeline's Linux leg. The version comes from --tag
// (local builds are 0.0.0-dev). `mobile` runs Gradle (JDK 21 and the Android SDK); `image` takes
// syft's SBOM of the Docker image as --input.
//   node infra/src/release/build-sbom.ts --deliverable desktop --out sbom [--tag v1.2.3] [--input FILE]
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { versionFromTag } from '@newses/shared/release';
import { REPO_ROOT } from '../config.ts';
import { checkSbomOptions, deliverableBom } from './deliverable-bom.ts';
import { type Bom, sbomName } from './sbom.ts';

const { values } = parseArgs({
  options: {
    deliverable: { type: 'string' },
    out: { type: 'string' },
    tag: { type: 'string' },
    input: { type: 'string' },
  },
});
const { deliverable, out } = checkSbomOptions(values);
const version = versionFromTag(values.tag).name;

function run(command: string, args: string[], options: SpawnSyncOptions = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
  return String(result.stdout);
}

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Bom;

const { repository } = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  repository?: { url?: string };
};
const bom = await deliverableBom(deliverable, version, repository?.url, {
  pnpm: (args) => JSON.parse(run('pnpm', args)) as Bom,
  gradle: () => {
    const android = join(REPO_ROOT, 'mobile/android');
    const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
    run(gradlew, ['-q', ':app:cyclonedxDirectBom'], { cwd: android, stdio: 'inherit' });
    return readJson(join(android, 'app/build/reports/cyclonedx-direct/bom.json'));
  },
  input: values.input === undefined ? undefined : await readJson(values.input),
});
await mkdir(out, { recursive: true });
const path = join(out, sbomName(version, deliverable));
await writeFile(path, `${JSON.stringify(bom, null, 2)}\n`);
console.log(`Wrote ${path} (${String(bom.components?.length ?? 0)} components)`);
