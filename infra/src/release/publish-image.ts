// Publishes the release's server image (infra/buildspec/release-publish.yml) in two steps, in the
// order the downloads go (image-registry.ts). `join`, before the uploads, joins the image legs'
// digests under the version's tag, signs the image with cosign and --key, and prints the image's
// reference, which the published compose file pins. `tag`, after the URL check, moves the tags
// image.ts plans to it, then deletes the superseded prereleases with their images and signatures.
// --dry-run pushes nothing: `join` prints the reference the image would have, and `tag` prints
// the plan and deletes the legs' images, which nothing tags.
//   node infra/src/release/publish-image.ts join|tag --dir artifacts --tag v1.2.3 \
//     --repository public.ecr.aws/<alias>/newses --key awskms:///<key alias ARN> [--dry-run]
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { versionFromTag } from '@newses/shared/release';
import { IMAGE_ARCHES, imageDigestName, parseDigest } from './image.ts';
import { joinImage, type Run, tagImage } from './image-registry.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string' },
    tag: { type: 'string' },
    repository: { type: 'string' },
    key: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const [step] = positionals;
if (
  (step !== 'join' && step !== 'tag') ||
  !values.dir ||
  !values.tag ||
  !values.repository ||
  !values.key
) {
  throw new Error(
    'Usage: publish-image.ts join|tag --dir DIR --tag TAG --repository URI --key KEY [--dry-run]',
  );
}
const { dir } = values;

const run: Run = (command, args, quiet = true) => {
  const result = spawnSync(command, args, {
    stdio: ['ignore', quiet ? 'pipe' : 2, 'inherit'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
  return result.stdout;
};

const options = {
  run,
  repository: values.repository,
  version: versionFromTag(values.tag).name,
  key: values.key,
  legs: await Promise.all(
    IMAGE_ARCHES.map(async (arch) =>
      parseDigest(await readFile(join(dir, imageDigestName(arch)), 'utf8')),
    ),
  ),
  dryRun: values['dry-run'],
};
if (step === 'join') {
  console.log(
    await joinImage({
      ...options,
      log: (line) => {
        console.error(line);
      },
    }),
  );
} else {
  tagImage({
    ...options,
    log: (line) => {
      console.log(line);
    },
  });
}
