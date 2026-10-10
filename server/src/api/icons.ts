import type { FastifyReply } from 'fastify';
import type { IconTokens } from '../core/feeds/favicons.ts';
import type { Blob } from '../core/ports.ts';

/** Feed icons without a session: `/feed-icons/<user segment>/<subscription id>.ico`. */
export const ICONS_PATH = 'feed-icons';

/** The user's icon path, as the native API gives it. */
export const iconsPath = (tokens: IconTokens, userId: number) =>
  `/${ICONS_PATH}/${tokens.issue(userId)}`;

/** Sends a stored feed icon, sandboxed: icons may be SVG, which must never run script here. */
export function sendIcon(reply: FastifyReply, icon: Blob) {
  return reply
    .type(icon.contentType)
    .header('cache-control', 'private, max-age=86400')
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
    .send(Buffer.from(icon.data));
}
