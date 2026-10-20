// How a desktop install updates, from the feed electron-builder writes into release builds
// (resources/app-update.yml; electron-builder.release.cjs). Builds without one never update.

export interface UpdateConfig {
  /** The stage's downloads URL, which serves the feeds and the downloads page. */
  url: string;
  /** The Windows signing publisher updates must match; release builds on Windows have one. */
  publisherName: string | null;
}

/** `auto`: downloads and installs on restart; `manual`: links to the downloads page. */
export type UpdateMode = 'auto' | 'manual';

/** Every 6 hours, and at launch; checks reach only CloudFront and S3, never the API. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const value = (yaml: string, key: string) => {
  const match = new RegExp(`^${key}: *(.+)$`, 'm').exec(yaml);
  return match?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2') ?? null;
};

/** The generic feed in app-update.yml; null for any other provider or an unparsable file. */
export function parseUpdateConfig(yaml: string): UpdateConfig | null {
  const url = value(yaml, 'url');
  if (value(yaml, 'provider') !== 'generic' || !url?.startsWith('https://')) return null;
  // electron-builder writes a single publisher as a list item on the next line.
  const publisher =
    value(yaml, 'publisherName') ?? /^publisherName:\s*\n\s*- (.+)$/m.exec(yaml)?.[1];
  return { url: url.replace(/\/$/, ''), publisherName: publisher?.trim() ?? null };
}

export interface Install {
  platform: NodeJS.Platform;
  /** Set by the AppImage runtime to the image's path. */
  appImage: string | undefined;
  /** NSIS installs keep their uninstaller beside the app; a zip does not. */
  hasUninstaller: boolean;
  /** The Windows portable exe, which runs from a temporary folder (portable.ts). */
  portable: boolean;
  config: UpdateConfig;
}

/**
 * AppImages and signed NSIS installs replace themselves; a deb (installed by the package manager),
 * the Windows zip, and the portable exe link to the download instead.
 */
export function updateMode(install: Install): UpdateMode {
  if (install.platform === 'linux') return install.appImage ? 'auto' : 'manual';
  if (
    install.platform === 'win32' &&
    !install.portable &&
    install.hasUninstaller &&
    install.config.publisherName
  ) {
    return 'auto';
  }
  return 'manual';
}
