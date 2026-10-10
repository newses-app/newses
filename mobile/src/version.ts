/** The app version from a release tag (`v1.2.3`, `v1.2.3-rc.1`); local builds get `0.0.0-dev`. */
export interface AppVersion {
  name: string;
  /** Android `versionCode`: major·10000 + minor·100 + patch, so later releases sort higher. */
  code: number;
}

const TAG = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

export function versionFromTag(tag: string | undefined): AppVersion {
  if (!tag) return { name: '0.0.0-dev', code: 1 };
  const match = TAG.exec(tag);
  if (!match) throw new Error(`Not a release tag: ${tag}`);
  const [major, minor, patch] = match.slice(1, 4).map(Number) as [number, number, number];
  if (minor > 99 || patch > 99) throw new Error(`Minor and patch must be below 100: ${tag}`);
  return { name: tag.replace(/^v/, ''), code: major * 10000 + minor * 100 + patch };
}
