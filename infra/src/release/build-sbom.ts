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
import {
  type Bom,
  type Deliverable,
  DELIVERABLES,
  deliverableRoot,
  isFirstParty,
  mergeBoms,
  type PnpmSource,
  SOURCES,
  SPEC_VERSION,
  sbomName,
  select,
  splice,
} from './sbom.ts';

const { values } = parseArgs({
  options: {
    deliverable: { type: 'string' },
    out: { type: 'string' },
    tag: { type: 'string' },
    input: { type: 'string' },
  },
});
const deliverable = values.deliverable as Deliverable | undefined;
if (!deliverable || !DELIVERABLES.includes(deliverable) || !values.out) {
  throw new Error(
    `Usage: build-sbom.ts --deliverable ${DELIVERABLES.join('|')} --out DIR [--tag TAG] [--input FILE]`,
  );
}
const sources = SOURCES[deliverable];
if (Boolean(sources.input) !== Boolean(values.input)) {
  throw new Error(
    sources.input ? `${deliverable} needs --input` : `${deliverable} takes no --input`,
  );
}
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

const fromPnpm = (source: PnpmSource) => {
  const bom = JSON.parse(
    run('pnpm', [
      '--silent',
      'sbom',
      '--sbom-format',
      'cyclonedx',
      '--sbom-spec-version',
      SPEC_VERSION,
      '--filter',
      source.filter,
      ...(source.prod ? ['--prod'] : []),
    ]),
  ) as Bom;
  return source.keep ? select(bom, source.keep) : bom;
};

const fromGradle = async () => {
  const android = join(REPO_ROOT, 'mobile/android');
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  run(gradlew, ['-q', ':app:cyclonedxDirectBom'], { cwd: android, stdio: 'inherit' });
  const path = join(android, 'app/build/reports/cyclonedx-direct/bom.json');
  return JSON.parse(await readFile(path, 'utf8')) as Bom;
};

const inputs = sources.pnpm.map(fromPnpm);
if (sources.gradle) inputs.push(await fromGradle());
if (values.input) inputs.push(JSON.parse(await readFile(values.input, 'utf8')) as Bom);

const { repository } = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  repository?: { url?: string };
};
const root = deliverableRoot(deliverable, version, repository?.url);
const bom = splice(mergeBoms(inputs, root), isFirstParty);
await mkdir(values.out, { recursive: true });
const path = join(values.out, sbomName(version, deliverable));
await writeFile(path, `${JSON.stringify(bom, null, 2)}\n`);
console.log(`Wrote ${path} (${String(bom.components?.length ?? 0)} components)`);
