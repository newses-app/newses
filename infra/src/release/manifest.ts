// What the release pipeline's publish leg uploads for a version: the files both build legs
// handed over, SHA256SUMS, the update feeds pointed at them, latest.json, and the downloads page.
import type { ReleaseFile, ReleaseManifest } from '@rss-reader/shared/release';
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
  windows: `rss-reader-${version}-windows-setup.exe`,
  windowsZip: `rss-reader-${version}-windows-x64.zip`,
  appImage: `rss-reader-${version}-linux-x86_64.AppImage`,
  deb: `rss-reader-${version}-linux-amd64.deb`,
  android: `rss-reader-${version}-android.apk`,
});

/** electron-updater's feeds: Windows (NSIS) and Linux (AppImage). */
export const FEEDS = ['latest.yml', 'latest-linux.yml'];

/** The NSIS installer's block map, for differential updates. */
const blockmapName = (version: string) => `${installerNames(version).windows}.blockmap`;

type Installer = 'windows' | 'windowsZip' | 'appImage' | 'deb' | 'android';
type ReleaseSbom = 'desktop' | 'mobile';

/**
 * The apps' CycloneDX SBOMs, built by the Linux leg, and the installers each describes:
 * desktop's packages are the same on every platform.
 */
const RELEASE_SBOMS: [ReleaseSbom, Installer[]][] = [
  ['desktop', ['windows', 'windowsZip', 'appImage', 'deb']],
  ['mobile', ['android']],
];
export const sbomNames = (version: string) =>
  RELEASE_SBOMS.map(([deliverable]) => sbomName(version, deliverable));

/** Each SBOM's file name and the installers it describes. */
export const sbomArtifacts = (version: string) =>
  RELEASE_SBOMS.map(([deliverable, installers]) => ({
    name: sbomName(version, deliverable),
    describes: installers.map((installer) => installerNames(version)[installer]),
  }));

/** The checksums of a version's files, for `sha256sum -c`. */
export const CHECKSUMS = 'SHA256SUMS';

/** The files uploaded under `<version>/` that came from the build legs. */
const versionedNames = (version: string) => [
  ...Object.values(installerNames(version)),
  blockmapName(version),
  ...sbomNames(version),
];

const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

const CONTENT_TYPES: Record<string, string> = {
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.zip': 'application/zip',
  '.AppImage': 'application/vnd.appimage',
  '.deb': 'application/vnd.debian.binary-package',
  '.apk': 'application/vnd.android.package-archive',
  '.blockmap': 'application/octet-stream',
  '.yml': 'text/yaml',
  '.json': 'application/json',
  '.html': 'text/html',
};

const contentType = (name: string) => {
  if (name.endsWith('.cdx.json')) return 'application/vnd.cyclonedx+json';
  if (name === CHECKSUMS) return 'text/plain; charset=utf-8';
  const type = CONTENT_TYPES[name.slice(name.lastIndexOf('.'))];
  if (!type) throw new Error(`No content type for ${name}`);
  return type;
};

/**
 * Checks that the build legs handed over exactly this version's files: a missing one means a
 * leg failed, and an extra one means a stale or misnamed build.
 */
export function checkBuiltFiles(version: string, names: string[]) {
  const expected = [...versionedNames(version), ...FEEDS];
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

export interface ManifestInput {
  version: string;
  versionCode: number;
  prerelease: boolean;
  published: Date;
  /** The stage's downloads URL, without a trailing slash. */
  baseUrl: string;
  files: BuiltFile[];
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
  return {
    version: input.version,
    prerelease: input.prerelease,
    published: input.published.toISOString(),
    windows: { installer: file(names.windows), zip: file(names.windowsZip) },
    linux: { appImage: file(names.appImage), deb: file(names.deb) },
    android: { ...file(names.android), versionCode: input.versionCode },
  };
}

/** The SBOMs, for the downloads page; latest.json leaves them out, as the apps never read them. */
export const sbomFiles = (input: ManifestInput) =>
  Object.fromEntries(
    RELEASE_SBOMS.map(([deliverable]) => [
      deliverable,
      releaseFile(input, sbomName(input.version, deliverable)),
    ]),
  ) as Record<ReleaseSbom, ReleaseFile>;

/** SHA256SUMS: a `sha256sum -c` line for each file from the build legs, and only those. */
export function renderChecksums(version: string, files: BuiltFile[]) {
  return versionedNames(version)
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
const fetchAndCheck = (file: ReleaseFile, shell: 'powershell' | 'sh') => {
  const name = fileName(file.url);
  return shell === 'powershell'
    ? [
        `curl.exe -fLO ${file.url}`,
        '# True when the file is intact',
        `(Get-FileHash ${name} -Algorithm SHA256).Hash -eq '${file.sha256}'`,
      ]
    : [`curl -fLO ${file.url}`, `echo '${file.sha256}  ${name}' | sha256sum -c`];
};

/** The commands that download, check, and install one file. */
export function installCommands(kind: Installer | 'sbom', file: ReleaseFile) {
  const name = fileName(file.url);
  switch (kind) {
    case 'windows':
      return [...fetchAndCheck(file, 'powershell'), `.\\${name}`];
    case 'windowsZip':
      return [
        ...fetchAndCheck(file, 'powershell'),
        `Expand-Archive ${name} -DestinationPath rss-reader`,
        '.\\rss-reader\\rss-reader.exe',
      ];
    case 'deb':
      return [...fetchAndCheck(file, 'sh'), `sudo apt install ./${name}`];
    case 'appImage':
      return [...fetchAndCheck(file, 'sh'), `chmod +x ${name}`, `./${name}`];
    case 'android':
      return ['# From a computer, with adb', ...fetchAndCheck(file, 'sh'), `adb install ${name}`];
    case 'sbom':
      return fetchAndCheck(file, 'sh');
  }
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

/** The static downloads page for the latest release. */
export function renderIndex(manifest: ReleaseManifest, sboms: Record<ReleaseSbom, ReleaseFile>) {
  const installers: [string, string, Installer | 'sbom', ReleaseFile][] = [
    [
      'Windows',
      'Installer for Windows 10 and 11 (x64), per user; updates itself',
      'windows',
      manifest.windows.installer,
    ],
    [
      'Windows',
      'Zip of the app (x64), to run without installing; does not update itself',
      'windowsZip',
      manifest.windows.zip,
    ],
    ['Linux', 'Debian and Ubuntu package (x64)', 'deb', manifest.linux.deb],
    [
      'Linux',
      'AppImage (x64); on Ubuntu 24.04 and later AppArmor stops its sandbox, so use the package',
      'appImage',
      manifest.linux.appImage,
    ],
    [
      'Android',
      'APK for Android 7 and later; open it on the phone and allow installs from your browser',
      'android',
      manifest.android,
    ],
  ];
  const boms: typeof installers = [
    ['Desktop SBOM', 'CycloneDX bill of materials for the desktop apps', 'sbom', sboms.desktop],
    ['Android SBOM', 'CycloneDX bill of materials for the Android app', 'sbom', sboms.mobile],
  ];
  const list = (rows: typeof installers) =>
    rows
      .map(([heading, description, kind, file]) => {
        const commands = escapeHtml(installCommands(kind, file).join('\n'));
        return `      <li>
        <h2>${heading}</h2>
        <p>${escapeHtml(description)}</p>
        <a href="${escapeHtml(file.url)}">${escapeHtml(fileName(file.url))}</a> <span>${megabytes(file.size)}</span>
        <code>SHA-256 ${file.sha256}</code>
        <details>
          <summary>${kind === 'sbom' ? 'Download and verify' : 'Install and verify'}</summary>
          <pre><code>${commands}</code></pre>
        </details>
      </li>`;
      })
      .join('\n');
  const checksums = escapeHtml(
    `${manifest.android.url.slice(0, manifest.android.url.lastIndexOf('/') + 1)}${CHECKSUMS}`,
  );
  const version = escapeHtml(manifest.version);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>rss-reader ${version} downloads</title>
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
    <h1>rss-reader ${version}${manifest.prerelease ? ' (prerelease)' : ''}</h1>
    <p>Published ${manifest.published.slice(0, 10)}. The apps connect to any rss-reader server over HTTPS, and the desktop apps update themselves.</p>
    <ul>
${list(installers)}
    </ul>
    <h2>Checksums and bills of materials</h2>
    <p><a href="${checksums}">${CHECKSUMS}</a> lists every file's SHA-256. To check several downloads at once, from the folder that has them:</p>
    <pre><code>curl -fLO ${checksums}
sha256sum -c --ignore-missing ${CHECKSUMS}</code></pre>
    <ul>
${list(boms)}
    </ul>
    <p><a href="/">Open the web app</a></p>
  </body>
</html>
`;
}

/** Versioned files first, then the feeds, latest.json, and the page that point at them. */
export function uploadPlan(version: string, prefix: string): Upload[] {
  const versioned = [...versionedNames(version), CHECKSUMS].map((name) => ({
    name,
    key: `${prefix}/${version}/${name}`,
    contentType: contentType(name),
    cacheControl: IMMUTABLE,
    // Installers download; the block map, SBOMs, and checksums are read by tools.
    attachment: /\.(exe|zip|AppImage|deb|apk)$/.test(name),
  }));
  const latest = [...FEEDS, 'latest.json', 'index.html'].map((name) => ({
    name,
    key: `${prefix}/${name}`,
    contentType: contentType(name),
    cacheControl: NO_CACHE,
    attachment: false,
  }));
  return [...versioned, ...latest];
}
