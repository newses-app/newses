import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ThirdPartyLicense } from '@newses/shared';

/**
 * The licences of the server's dependencies. The image and Lambda builds write them next to this
 * module (bundled, next to the handler); development servers have none.
 */
const LICENSES_FILE = fileURLToPath(new URL('./third-party-licenses.json', import.meta.url));

let licenses: Promise<ThirdPartyLicense[] | null> | undefined;

export function serverLicenses(): Promise<ThirdPartyLicense[] | null> {
  licenses ??= readFile(LICENSES_FILE, 'utf8').then(
    (text) => JSON.parse(text) as ThirdPartyLicense[],
    () => null,
  );
  return licenses;
}
