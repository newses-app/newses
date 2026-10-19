import { z } from 'zod';

export const MAX_INSTANCE_NAME_LENGTH = 100;

/** `GET /server`: lets apps confirm a URL is a Newses server and check compatibility. */
export const serverInfoSchema = z.object({
  /** `PRODUCT_NAME`, or one of `LEGACY_PRODUCT_NAMES` from servers not yet updated. */
  product: z.string(),
  /** The server build, or `dev` when the build did not set one. */
  version: z.string(),
  apiVersion: z.object({ major: z.number().int(), minor: z.number().int() }),
  /** What the operator calls this server (`INSTANCE_NAME`); apps name a new profile by it. */
  name: z.string().max(MAX_INSTANCE_NAME_LENGTH).optional(),
});

export type ServerInfo = z.infer<typeof serverInfoSchema>;
