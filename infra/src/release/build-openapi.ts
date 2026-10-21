// Writes the native API's OpenAPI document, as `/api/v1/openapi.json` serves it, to
// DIR/newses-<version>-openapi.json for the release pipeline's Linux leg. No database is needed.
// The version comes from --tag (local builds are 0.0.0-dev).
//   node infra/src/release/build-openapi.ts --out openapi [--tag v1.2.3]
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openApiDocument } from '@newses/server/openapi';
import { versionFromTag } from '@newses/shared/release';
import { openapiName } from './manifest.ts';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    tag: { type: 'string' },
  },
});
if (!values.out) throw new Error('Usage: build-openapi.ts --out DIR [--tag TAG]');
const version = versionFromTag(values.tag).name;

const document = await openApiDocument();
await mkdir(values.out, { recursive: true });
const path = join(values.out, openapiName(version));
await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Wrote ${path} (${String(Object.keys(document.paths ?? {}).length)} paths)`);
