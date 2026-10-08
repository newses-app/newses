import type { FastifyReply } from 'fastify';
import type { Blob } from '../core/ports.ts';

/** Sends a stored feed icon, sandboxed: icons may be SVG, which must never run script here. */
export function sendIcon(reply: FastifyReply, icon: Blob) {
  return reply
    .type(icon.contentType)
    .header('cache-control', 'private, max-age=86400')
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
    .send(Buffer.from(icon.data));
}
