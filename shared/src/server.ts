import { z } from 'zod';

/** `GET /server`: lets apps confirm a URL is a Newses server and check compatibility. */
export const serverInfoSchema = z.object({
  /** `PRODUCT_NAME`, or one of `LEGACY_PRODUCT_NAMES` from servers not yet updated. */
  product: z.string(),
  /** The server build, or `dev` when the build did not set one. */
  version: z.string(),
  apiVersion: z.object({ major: z.number().int(), minor: z.number().int() }),
});

export type ServerInfo = z.infer<typeof serverInfoSchema>;
