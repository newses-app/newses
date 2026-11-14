// Uploads the SBOMs in DIR (build-sbom.ts's file names) to Dependency-Track and waits for each
// to be processed (dtrack.ts). The server is DTRACK_URL (default http://localhost:8080) and the
// key DTRACK_API_KEY, from the environment or dtrack.env at the repository root.
//   node infra/src/release/upload-sbom.ts --dir sbom (--tag v1.2.3 | --branch dev)
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { REPO_ROOT } from '../config.ts';
import { dtrackApi, sbomsToUpload, uploadBom, uploadTarget } from './dtrack.ts';

const { values } = parseArgs({
  options: { dir: { type: 'string' }, tag: { type: 'string' }, branch: { type: 'string' } },
});
const { dir, tag, branch } = values;
if (!dir || Boolean(tag) === Boolean(branch)) {
  throw new Error('Usage: upload-sbom.ts --dir DIR (--tag TAG | --branch BRANCH)');
}

const envFile = join(REPO_ROOT, 'dtrack.env');
if (!process.env.DTRACK_API_KEY && existsSync(envFile)) process.loadEnvFile(envFile);
const apiKey = process.env.DTRACK_API_KEY;
if (!apiKey) throw new Error(`DTRACK_API_KEY not set, in the environment or ${envFile}`);
const api = dtrackApi(process.env.DTRACK_URL ?? 'http://localhost:8080', apiKey);

for (const file of sbomsToUpload(dir, await readdir(dir), tag)) {
  const target = uploadTarget(file.deliverable, { tag, branch });
  await uploadBom(api, file.name, target, await readFile(join(dir, file.name), 'utf8'));
  console.log(`Uploaded ${file.name} to ${target.projectName} ${target.projectVersion}`);
}
