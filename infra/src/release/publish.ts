// Prepares a release for upload (infra/buildspec/release-publish.yml; prepare-release.ts): checks
// the build legs' files, adds the server's with --image (publish-image.ts join's reference) and
// --public-key, and writes SHA256SUMS, the feeds, latest.json, index.html, plan.tsv, and urls.txt
// beside them. --platforms names the apps built (default all, as on AWS; Docker builds Linux and
// Android).
//   node infra/src/release/publish.ts --dir artifacts --tag v1.2.3 --url https://host/downloads \
//     [--platforms linux,android] [--image public.ecr.aws/<alias>/newses@sha256:… --public-key cosign.pub]
import { parseArgs } from 'node:util';
import { PLATFORMS } from '@newses/shared/release';
import { prepareRelease } from './prepare-release.ts';

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    tag: { type: 'string' },
    url: { type: 'string' },
    prerelease: { type: 'boolean', default: false },
    platforms: { type: 'string', default: PLATFORMS.join(',') },
    image: { type: 'string' },
    'public-key': { type: 'string' },
  },
});
if (!values.dir || !values.tag || !values.url) {
  throw new Error(
    'Usage: publish.ts --dir DIR --tag TAG --url DOWNLOADS_URL [--prerelease] [--platforms LIST] [--image REPOSITORY@DIGEST --public-key FILE]',
  );
}
const manifest = await prepareRelease({
  dir: values.dir,
  tag: values.tag,
  url: values.url,
  prerelease: values.prerelease,
  platforms: values.platforms,
  image: values.image,
  publicKey: values['public-key'],
});
console.log(JSON.stringify(manifest, null, 2));
