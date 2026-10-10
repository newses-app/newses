import { z } from 'zod';

/** `GET /server`: lets apps confirm a URL is an rss-reader server and check compatibility. */
export const serverInfoSchema = z.object({
  /** Always `rss-reader`. */
  product: z.string(),
  /** The server build, or `dev` when the build did not set one. */
  version: z.string(),
  apiVersion: z.object({ major: z.number().int(), minor: z.number().int() }),
});

export type ServerInfo = z.infer<typeof serverInfoSchema>;
