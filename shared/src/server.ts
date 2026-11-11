import { z } from 'zod';

export const MAX_INSTANCE_NAME_LENGTH = 100;

/** `GET /server`: lets apps confirm a URL is a Newses server and check compatibility. */
export const serverInfoSchema = z.object({
  /** `PRODUCT_NAME`, or one of `LEGACY_PRODUCT_NAMES` from servers not yet updated. */
  product: z.string(),
  /** The server build, or `dev` when the build did not set one. */
  version: z.string(),
  apiVersion: z.object({ major: z.number().int(), minor: z.number().int() }),
  /** What the operator calls this server (`INSTANCE_NAME`); apps name profiles `user @ name`. */
  name: z.string().max(MAX_INSTANCE_NAME_LENGTH).optional(),
  /** Where to get this server's source code (`SOURCE_URL`, AGPL §13); from API 1.9. */
  source: z.url().optional(),
  /** Web Push (RFC 8292): the server's VAPID public key, base64url; from API 1.11. */
  push: z.object({ key: z.string() }).optional(),
});

export type ServerInfo = z.infer<typeof serverInfoSchema>;

/** `GET /server/licenses`: a package the server runs, with its licence (`ThirdPartyLicense`). */
export const thirdPartyLicenseSchema = z.object({
  name: z.string(),
  version: z.string(),
  license: z.string(),
  text: z.string().optional(),
  notice: z.string().optional(),
  url: z.string().optional(),
});
