// What the release pipeline's publish leg uploads for a version: the files the build legs
// handed over, SHA256SUMS, the update feeds pointed at them, latest.json, and the downloads page.
// `platforms` are the apps it built: all three on AWS, those asked for on Docker. `image` is set when the stage publishes the server image, whose legs hand over its SBOM too,
// and whose compose file, sample config, nginx-proxy override, and signing key the publish leg
// adds.
import {
  CHECKSUMS,
  DOWNLOADS_CACHE,
  downloadsAsAttachment,
  downloadType,
  type Platform,
  PLATFORMS,
  type ReleaseFile,
  type ReleaseManifest,
  type ServerRelease,
} from '@newses/shared/release';
import { IMAGE_ARCHES, imageDigestName } from './image.ts';
import { sbomName } from './sbom.ts';

/** A built file: name, size in bytes, and SHA-256 (hex). */
export interface BuiltFile {
  name: string;
  size: number;
  sha256: string;
}

/** One object to upload under the downloads prefix. */
export interface Upload {
  /** Built file name, or a generated file's name. */
  name: string;
  key: string;
  contentType: string;
  cacheControl: string;
  /** Installers download rather than open. */
  attachment: boolean;
}

/** The installers each version ships, by electron-builder's and the mobile build's naming. */
export const installerNames = (version: string): Record<Installer, string> => ({
  windows: `newses-${version}-windows-setup.exe`,
  windowsZip: `newses-${version}-windows-x64.zip`,
  windowsPortable: `newses-${version}-windows-portable.exe`,
  appImage: `newses-${version}-linux-x86_64.AppImage`,
  deb: `newses-${version}-linux-amd64.deb`,
  android: `newses-${version}-android.apk`,
});

const PLATFORM_OF: Record<Installer, Platform> = {
  windows: 'windows',
  windowsZip: 'windows',
  windowsPortable: 'windows',
  appImage: 'linux',
  deb: 'linux',
  android: 'android',
};

/** The installers of `platforms`. */
const installersOf = (platforms: readonly Platform[]) =>
  (Object.keys(PLATFORM_OF) as Installer[]).filter((installer) =>
    platforms.includes(PLATFORM_OF[installer]),
  );

/** electron-updater's feeds: Windows (NSIS) and Linux (AppImage), of the platforms built. */
export const feeds = (platforms: readonly Platform[] = PLATFORMS) => [
  ...(platforms.includes('windows') ? ['latest.yml'] : []),
  ...(platforms.includes('linux') ? ['latest-linux.yml'] : []),
];

/** The NSIS installer's block map, for differential updates. */
const blockmapName = (version: string) => `${installerNames(version).windows}.blockmap`;

type Installer = 'windows' | 'windowsZip' | 'windowsPortable' | 'appImage' | 'deb' | 'android';
type ReleaseSbom = 'desktop' | 'mobile' | 'image';

/**
 * The CycloneDX SBOMs and the installers each describes: the apps', built by the Linux leg
 * (desktop's packages are the same on every platform), and the server image's, built by the
 * amd64 image leg.
 */
const RELEASE_SBOMS: [ReleaseSbom, Installer[]][] = [
  ['desktop', ['windows', 'windowsZip', 'windowsPortable', 'appImage', 'deb']],
  ['mobile', ['android']],
  ['image', []],
];
/** The SBOMs of the platforms built, each with the installers it describes of them. */
const releaseSboms = (image: boolean, platforms: readonly Platform[]) =>
  RELEASE_SBOMS.map(([deliverable, installers]): [ReleaseSbom, Installer[]] => [
    deliverable,
    installers.filter((installer) => installersOf(platforms).includes(installer)),
  ]).filter(([deliverable, installers]) =>
    deliverable === 'image' ? image : installers.length > 0,
  );
export const sbomNames = (
  version: string,
  image = false,
  platforms: readonly Platform[] = PLATFORMS,
) => releaseSboms(image, platforms).map(([deliverable]) => sbomName(version, deliverable));

/** Each SBOM's file name and the installers it describes. */
export const sbomArtifacts = (
  version: string,
  image = false,
  platforms: readonly Platform[] = PLATFORMS,
) =>
  releaseSboms(image, platforms).map(([deliverable, installers]) => ({
    name: sbomName(version, deliverable),
    describes: installers.map((installer) => installerNames(version)[installer]),
  }));

/** The native API's OpenAPI document, built by the Linux leg as `/api/v1/openapi.json` serves it. */
export const openapiName = (version: string) => `newses-${version}-openapi.json`;

type ServerFile = Exclude<keyof ServerRelease, 'image'>;

/** The server's files, which the publish leg adds when it publishes the image. */
export const serverNames = (version: string): Record<ServerFile, string> => ({
  compose: `newses-${version}-compose.yaml`,
  env: `newses-${version}-env.example`,
  nginxProxy: `newses-${version}-compose.nginx-proxy.yaml`,
  publicKey: `newses-${version}-cosign.pub`,
});

/**
 * The name the install commands give each server file, and, but for the signing key, its source
 * in `docker/`.
 */
export const SERVER_FILES: Record<ServerFile, string> = {
  compose: 'compose.yaml',
  env: '.env.example',
  nginxProxy: 'compose.nginx-proxy.yaml',
  publicKey: 'cosign.pub',
};

export { CHECKSUMS };

/** The files under `<version>/` that came from the build legs. */
const handedOverNames = (version: string, image: boolean, platforms: readonly Platform[]) => [
  ...installersOf(platforms).map((installer) => installerNames(version)[installer]),
  ...(platforms.includes('windows') ? [blockmapName(version)] : []),
  ...sbomNames(version, image, platforms),
  openapiName(version),
];

/** The files uploaded under `<version>/`, but SHA256SUMS. */
const versionedNames = (version: string, image: boolean, platforms: readonly Platform[]) => [
  ...handedOverNames(version, image, platforms),
  ...(image ? Object.values(serverNames(version)) : []),
];

/** The image legs' digests, for the publish leg alone. */
export const imageDigestNames = (image: boolean) =>
  image ? IMAGE_ARCHES.map(imageDigestName) : [];

const contentType = (name: string) => {
  const type = downloadType(name);
  if (!type) throw new Error(`No content type for ${name}`);
  return type;
};

/**
 * Checks that the build legs handed over exactly this version's files: a missing one means a
 * leg failed, and an extra one means a stale or misnamed build.
 */
export function checkBuiltFiles(
  version: string,
  names: string[],
  image = false,
  platforms: readonly Platform[] = PLATFORMS,
) {
  const expected = [
    ...handedOverNames(version, image, platforms),
    ...feeds(platforms),
    ...imageDigestNames(image),
  ];
  const missing = expected.filter((name) => !names.includes(name));
  const unexpected = names.filter((name) => !expected.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Release ${version} files do not match: missing [${missing.join(', ')}], unexpected [${unexpected.join(', ')}]`,
    );
  }
}

/**
 * Points an electron-updater feed at the version's folder: the feed sits at the downloads root
 * and the installers under `<version>/`. The feed must be for this version.
 */
export function rewriteFeed(feed: string, version: string) {
  if (!new RegExp(`^version: '?${version.replaceAll('.', '\\.')}'?$`, 'm').test(feed)) {
    throw new Error(`Feed is not for version ${version}`);
  }
  let count = 0;
  const rewritten = feed.replace(/^(\s*(?:- )?(?:url|path): )(\S+)$/gm, (_, prefix, file) => {
    count++;
    return `${prefix as string}${version}/${file as string}`;
  });
  if (count === 0) throw new Error('Feed lists no files');
  return rewritten;
}

const DEFAULT_IMAGE = '${NEWSES_IMAGE:-newses:latest}';

/**
 * The release's compose file from `docker/compose.yaml`, comments kept: the image pinned to
 * `image` (`<repository>:<version>@<digest>`), still overridable with NEWSES_IMAGE, and nothing
 * built, so it runs from a folder holding only it and `.env`.
 */
export function renderCompose(source: string, image: string) {
  if (source.split(DEFAULT_IMAGE).length !== 2) {
    throw new Error(`The compose file names ${DEFAULT_IMAGE} other than once`);
  }
  const rendered = source
    .replace(DEFAULT_IMAGE, `\${NEWSES_IMAGE:-${image}}`)
    .replace(/^( *)build:\n(?:\1 +\S.*\n)+/m, '');
  if (/^\s*build:/m.test(rendered)) throw new Error('The compose file still builds an image');
  if (/^\s*(?:- |source: )['"]?\.\.?\//m.test(rendered)) {
    throw new Error('The compose file mounts host files');
  }
  return rendered;
}

/** The server image a stage publishes, from publish-image.ts. */
export interface ServerImage {
  repository: string;
  digest: string;
}

export interface ManifestInput {
  version: string;
  versionCode: number;
  prerelease: boolean;
  published: Date;
  /** The stage's downloads URL, without a trailing slash. */
  baseUrl: string;
  files: BuiltFile[];
  /** The server image, when the stage publishes it. */
  image?: ServerImage | undefined;
  /** The apps built; all by default. */
  platforms?: readonly Platform[] | undefined;
}

const releaseFile = (input: ManifestInput, name: string): ReleaseFile => {
  const built = input.files.find((f) => f.name === name);
  if (!built) throw new Error(`Missing ${name}`);
  return {
    url: `${input.baseUrl}/${input.version}/${name}`,
    size: built.size,
    sha256: built.sha256,
  };
};

export function buildManifest(input: ManifestInput): ReleaseManifest {
  const names = installerNames(input.version);
  const file = (name: string) => releaseFile(input, name);
  const server = serverNames(input.version);
  const platforms = input.platforms ?? PLATFORMS;
  return {
    version: input.version,
    prerelease: input.prerelease,
    published: input.published.toISOString(),
    ...(platforms.includes('windows') && {
      windows: {
        installer: file(names.windows),
        zip: file(names.windowsZip),
        portable: file(names.windowsPortable),
      },
    }),
    ...(platforms.includes('linux') && {
      linux: { appImage: file(names.appImage), deb: file(names.deb) },
    }),
    ...(platforms.includes('android') && {
      android: { ...file(names.android), versionCode: input.versionCode },
    }),
    ...(input.image && {
      server: {
        image: {
          repository: input.image.repository,
          tag: input.version,
          digest: input.image.digest,
        },
        compose: file(server.compose),
        env: file(server.env),
        nginxProxy: file(server.nginxProxy),
        publicKey: file(server.publicKey),
      },
    }),
  };
}

/** A release's SBOMs: the apps' it built, and the image's when the stage publishes the image. */
export type SbomFiles = Partial<Record<ReleaseSbom, ReleaseFile>>;

/** The SBOMs, for the downloads page; latest.json leaves them out, as the apps never read them. */
export const sbomFiles = (input: ManifestInput) =>
  Object.fromEntries(
    releaseSboms(Boolean(input.image), input.platforms ?? PLATFORMS).map(([deliverable]) => [
      deliverable,
      releaseFile(input, sbomName(input.version, deliverable)),
    ]),
  ) as SbomFiles;

/** The OpenAPI document, for the downloads page; latest.json leaves it out too. */
export const openapiFile = (input: ManifestInput) => releaseFile(input, openapiName(input.version));

/** SHA256SUMS: a `sha256sum -c` line for each file from the build legs, and only those. */
export function renderChecksums(
  version: string,
  files: BuiltFile[],
  image = false,
  platforms: readonly Platform[] = PLATFORMS,
) {
  return versionedNames(version, image, platforms)
    .map((name) => {
      const file = files.find((f) => f.name === name);
      if (!file) throw new Error(`Missing ${name}`);
      return `${file.sha256}  ${name}\n`;
    })
    .join('');
}

const fileName = (url: string) => url.slice(url.lastIndexOf('/') + 1);

/**
 * Downloads a file and checks its SHA-256: PowerShell on Windows (curl.exe ships with Windows 10
 * and 11), a POSIX shell elsewhere.
 */
const fetchAndCheck = (file: ReleaseFile, shell: 'powershell' | 'sh', as?: string) => {
  const name = as ?? fileName(file.url);
  const curl = as ? `-fL -o ${as}` : '-fLO';
  return shell === 'powershell'
    ? [
        `curl.exe ${curl} ${file.url}`,
        '# True when the file is intact',
        `(Get-FileHash ${name} -Algorithm SHA256).Hash -eq '${file.sha256}'`,
      ]
    : [`curl ${curl} ${file.url}`, `echo '${file.sha256}  ${name}' | sha256sum -c`];
};

/** The commands that download, check, and install one file. */
export function installCommands(kind: Installer | 'file', file: ReleaseFile) {
  const name = fileName(file.url);
  switch (kind) {
    case 'windows':
    case 'windowsPortable':
      return [...fetchAndCheck(file, 'powershell'), `.\\${name}`];
    case 'windowsZip':
      return [
        ...fetchAndCheck(file, 'powershell'),
        `Expand-Archive ${name} -DestinationPath newses`,
        '.\\newses\\Newses.exe',
      ];
    case 'deb':
      return [...fetchAndCheck(file, 'sh'), `sudo apt install ./${name}`];
    case 'appImage':
      return [...fetchAndCheck(file, 'sh'), `chmod +x ${name}`, `./${name}`];
    case 'android':
      return ['# From a computer, with adb', ...fetchAndCheck(file, 'sh'), `adb install ${name}`];
    case 'file':
      return fetchAndCheck(file, 'sh');
  }
}

/**
 * The commands that download and check each server file under the name Compose looks for, and
 * install or start the server with it, or verify the image with the signing key.
 */
export function serverCommands(server: ServerRelease): Record<ServerFile, string[]> {
  return {
    compose: [
      'mkdir newses && cd newses',
      ...fetchAndCheck(server.compose, 'sh', SERVER_FILES.compose),
      ...fetchAndCheck(server.env, 'sh', '.env'),
      '# In .env, change POSTGRES_PASSWORD and set APP_SECRET to: openssl rand -base64 48',
      'docker compose up -d',
    ],
    env: fetchAndCheck(server.env, 'sh', SERVER_FILES.env),
    nginxProxy: [
      ...fetchAndCheck(server.nginxProxy, 'sh', SERVER_FILES.nginxProxy),
      '# In .env, set VIRTUAL_HOST, and LETSENCRYPT_HOST with acme-companion',
      `docker compose -f ${SERVER_FILES.compose} -f ${SERVER_FILES.nginxProxy} up -d`,
    ],
    publicKey: [
      ...fetchAndCheck(server.publicKey, 'sh', SERVER_FILES.publicKey),
      `cosign verify --key ${SERVER_FILES.publicKey} ${server.image.repository}:${server.image.tag}`,
    ],
  };
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

const megabytes = (size: number) => `${(size / 1024 / 1024).toFixed(1)} MB`;

/** The downloads page's Server section: the files that install it, and the image. */
function serverSection(
  server: ServerRelease,
  list: (rows: [string, string, ReleaseFile, string[], string][]) => string,
) {
  const commands = serverCommands(server);
  const { repository, tag, digest } = server.image;
  const byTag = escapeHtml(`${repository}:${tag}`);
  const byDigest = escapeHtml(`${repository}@${digest}`);
  return `    <h2>Server</h2>
    <p>Runs with Docker Compose on linux/amd64 and linux/arm64 hosts, from a folder holding the compose file and its .env.</p>
    <ul>
${list([
  [
    'Compose file',
    'Runs the server, its database, and optional backups and Grafana, on this release’s image; to upgrade, download a newer one over it and run docker compose up -d',
    server.compose,
    commands.compose,
    'Install and verify',
  ],
  [
    'Sample settings',
    'Every setting of .env, with its default',
    server.env,
    commands.env,
    'Download and verify',
  ],
  [
    'nginx-proxy override',
    'Runs the server behind nginx-proxy, which serves it over HTTPS with acme-companion',
    server.nginxProxy,
    commands.nginxProxy,
    'Install and verify',
  ],
  [
    'Signing key',
    'cosign public key that verifies the image’s signature, which Sigstore’s transparency log also records',
    server.publicKey,
    commands.publicKey,
    'Verify the image',
  ],
])}
      <li>
        <h2>Image</h2>
        <p>The image the compose file runs, by tag, or by digest, which always names these same bytes</p>
        <code>${byTag}</code>
        <code>${byDigest}</code>
        <details>
          <summary>Pull</summary>
          <pre><code>docker pull ${byTag}
docker pull ${byDigest}</code></pre>
        </details>
      </li>
    </ul>
`;
}

/** The static downloads page for the latest release. */
export function renderIndex(manifest: ReleaseManifest, sboms: SbomFiles, openapi: ReleaseFile) {
  type Entry = [string, string, Installer | 'file', ReleaseFile];
  /** The entries of the files the release has. */
  const present = (entries: [string, string, Installer | 'file', ReleaseFile | undefined][]) =>
    entries.filter((entry): entry is Entry => entry[3] !== undefined);
  const installers = present([
    [
      'Windows',
      'Installer for Windows 10 and 11 (x64), per user; updates itself',
      'windows',
      manifest.windows?.installer,
    ],
    [
      'Windows',
      'Zip of the app (x64), to run without installing; does not update itself',
      'windowsZip',
      manifest.windows?.zip,
    ],
    [
      'Windows',
      'Single exe of the app (x64), to run without installing, from a USB drive too; keeps its data in a Newses Data folder beside it, starts a few seconds slower, and does not update itself',
      'windowsPortable',
      manifest.windows?.portable,
    ],
    ['Linux', 'Debian and Ubuntu package (x64)', 'deb', manifest.linux?.deb],
    [
      'Linux',
      'AppImage (x64); on Ubuntu 24.04 and later AppArmor stops its sandbox, so use the package',
      'appImage',
      manifest.linux?.appImage,
    ],
    [
      'Android',
      'APK for Android 7 and later; open it on the phone and allow installs from your browser',
      'android',
      manifest.android,
    ],
  ]);
  const documents = present([
    ['Desktop SBOM', 'CycloneDX bill of materials for the desktop apps', 'file', sboms.desktop],
    ['Android SBOM', 'CycloneDX bill of materials for the Android app', 'file', sboms.mobile],
    [
      'Server image SBOM',
      'CycloneDX bill of materials for the server image, from its linux/amd64 build',
      'file',
      sboms.image,
    ],
    ['API description', 'OpenAPI document of the native API, /api/v1', 'file', openapi],
  ]);
  // Heading, description, file, commands, and what the commands do.
  type Row = [string, string, ReleaseFile, string[], string];
  const row = ([heading, description, kind, file]: Entry): Row => [
    heading,
    description,
    file,
    installCommands(kind, file),
    kind === 'file' ? 'Download and verify' : 'Install and verify',
  ];
  const list = (rows: Row[]) =>
    rows
      .map(([heading, description, file, lines, summary]) => {
        const commands = escapeHtml(lines.join('\n'));
        return `      <li>
        <h2>${heading}</h2>
        <p>${escapeHtml(description)}</p>
        <a href="${escapeHtml(file.url)}">${escapeHtml(fileName(file.url))}</a> <span>${megabytes(file.size)}</span>
        <code>SHA-256 ${file.sha256}</code>
        <details>
          <summary>${summary}</summary>
          <pre><code>${commands}</code></pre>
        </details>
      </li>`;
      })
      .join('\n');
  const checksums = escapeHtml(
    `${openapi.url.slice(0, openapi.url.lastIndexOf('/') + 1)}${CHECKSUMS}`,
  );
  const version = escapeHtml(manifest.version);
  const server = manifest.server && serverSection(manifest.server, list);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Newses ${version} downloads</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; }
      body { max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
      ul { list-style: none; padding: 0; }
      li { border-top: 1px solid #8884; padding: 1rem 0; }
      h2 { font-size: 1.1rem; margin: 0; }
      p { margin: 0.25rem 0; }
      span { opacity: 0.7; }
      code { display: block; font-size: 0.75rem; overflow-wrap: anywhere; opacity: 0.7; }
      summary { cursor: pointer; margin-top: 0.5rem; }
      pre { overflow-x: auto; padding: 0.5rem; background: #8881; border-radius: 4px; }
      pre code { display: inline; overflow-wrap: normal; opacity: 1; }
    </style>
  </head>
  <body>
    <h1>Newses ${version}${manifest.prerelease ? ' (prerelease)' : ''}</h1>
    <p>Published ${manifest.published.slice(0, 10)}. The apps connect to any Newses server over HTTPS, and the desktop apps update themselves.</p>
    <ul>
${list(installers.map(row))}
    </ul>
${server ?? ''}    <h2>Checksums, bills of materials, and API description</h2>
    <p><a href="${checksums}">${CHECKSUMS}</a> lists every file's SHA-256. To check several downloads at once, from the folder that has them:</p>
    <pre><code>curl -fLO ${checksums}
sha256sum -c --ignore-missing ${CHECKSUMS}</code></pre>
    <ul>
${list(documents.map(row))}
    </ul>
    <p><a href="/">Open the web app</a></p>
  </body>
</html>
`;
}

/** Versioned files first, then the feeds, latest.json, and the page that point at them. */
export function uploadPlan(
  version: string,
  prefix: string,
  image = false,
  platforms: readonly Platform[] = PLATFORMS,
): Upload[] {
  const versioned = [...versionedNames(version, image, platforms), CHECKSUMS].map((name) => ({
    name,
    key: `${prefix}/${version}/${name}`,
    contentType: contentType(name),
    cacheControl: DOWNLOADS_CACHE.versioned,
    attachment: downloadsAsAttachment(name),
  }));
  const latest = [...feeds(platforms), 'latest.json', 'index.html'].map((name) => ({
    name,
    key: `${prefix}/${name}`,
    contentType: contentType(name),
    cacheControl: DOWNLOADS_CACHE.latest,
    attachment: false,
  }));
  return [...versioned, ...latest];
}
