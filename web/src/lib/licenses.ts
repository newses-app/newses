import type { ThirdPartyLicense } from '@newses/shared';

/**
 * A licence list the build wrote beside index.html; null where it wrote none (the development
 * server answers with the app instead).
 */
export async function bundledLicenses(file: string): Promise<ThirdPartyLicense[] | null> {
  try {
    const response = await fetch(`/${file}`);
    if (!response.ok) return null;
    return (await response.json()) as ThirdPartyLicense[];
  } catch {
    return null;
  }
}

/** The packages whose name or licence contains `filter`, ignoring case. */
export function filterLicenses(licenses: ThirdPartyLicense[], filter: string) {
  const needle = filter.trim().toLowerCase();
  if (!needle) return licenses;
  return licenses.filter(
    (entry) =>
      entry.name.toLowerCase().includes(needle) || entry.license.toLowerCase().includes(needle),
  );
}
