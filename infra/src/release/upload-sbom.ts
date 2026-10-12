// Uploads the SBOMs in DIR (build-sbom.ts's file names) to Dependency-Track and waits for each
// to be processed. The server is DTRACK_URL (default http://localhost:8080) and the key
// DTRACK_API_KEY, from the environment or dtrack.env at the repository root.
//   node infra/src/release/upload-sbom.ts --dir sbom (--tag v1.2.3 | --branch dev)
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { versionFromTag } from '@rss-reader/shared/release';
import { REPO_ROOT } from '../config.ts';
import { bomUploadRequest, uploadTarget } from './dtrack.ts';
import { parseSbomName } from './sbom.ts';

const { values } = parseArgs({
  options: { dir: { type: 'string' }, tag: { type: 'string' }, branch: { type: 'string' } },
});
const { dir, tag, branch } = values;
if (!dir || Boolean(tag) === Boolean(branch)) {
  throw new Error('Usage: upload-sbom.ts --dir DIR (--tag TAG | --branch BRANCH)');
}

const envFile = join(REPO_ROOT, 'dtrack.env');
if (!process.env.DTRACK_API_KEY && existsSync(envFile)) process.loadEnvFile(envFile);
const baseUrl = (process.env.DTRACK_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const apiKey = process.env.DTRACK_API_KEY;
if (!apiKey) throw new Error(`DTRACK_API_KEY not set, in the environment or ${envFile}`);

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'X-Api-Key': apiKey ?? '',
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${String(response.status)} ${text.slice(0, 500)}`);
  }
  return text ? (JSON.parse(text) as unknown) : undefined;
}

// Files from another build would be uploaded under the wrong version.
const expected = versionFromTag(tag).name;
const files = (await readdir(dir)).flatMap((name) => {
  const parsed = parseSbomName(name);
  return parsed ? [{ name, ...parsed }] : [];
});
if (files.length === 0) throw new Error(`No SBOMs in ${dir}`);
const stale = files.filter((file) => file.version !== expected);
if (stale.length > 0) {
  throw new Error(`Not ${expected}: ${stale.map((file) => file.name).join(', ')}`);
}

for (const file of files) {
  const target = uploadTarget(file.deliverable, { tag, branch });
  const bom = await readFile(join(dir, file.name), 'utf8');
  const { token } = (await api('PUT', '/api/v1/bom', bomUploadRequest(target, bom))) as {
    token: string;
  };
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const status = (await api('GET', `/api/v1/event/token/${token}`)) as {
      processing: boolean;
      status?: string | null;
    };
    if (status.status === 'FAILED') throw new Error(`${file.name}: processing failed`);
    if (!status.processing) break;
    if (Date.now() > deadline) throw new Error(`${file.name}: still processing after 5 minutes`);
    await sleep(2000);
  }
  console.log(`Uploaded ${file.name} to ${target.projectName} ${target.projectVersion}`);
}
