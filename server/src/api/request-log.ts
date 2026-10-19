import { LogController, type FastifyBaseLogger, type FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Path parameters and query fields that are secrets, redacted from request logs at every level. */
    logSecrets?: readonly string[];
  }
}

const REDACTED = '[redacted]';
const DEBUG_LEVELS = new Set(['trace', 'debug']);

/**
 * The request's URL as logged: its route pattern, or `unmatched`; with debug logging on, the URL
 * itself, with the route's `logSecrets` redacted. Paths and queries carry feed, page, and image
 * URLs, published-feed keys, and share ids, which reach logs only as the operator allows.
 */
export function loggedUrl(request: FastifyRequest, debug: boolean): string {
  const pattern = request.routeOptions.url;
  if (!debug) return pattern ?? 'unmatched';
  if (!pattern) return request.url;
  const secrets = new Set(request.routeOptions.config.logSecrets ?? []);
  const params = (request.params ?? {}) as Record<string, unknown>;
  const path = pattern.replace(/:(\w+)|\*/g, (token: string, name?: string) => {
    const key = name ?? '*';
    if (secrets.has(key)) return REDACTED;
    const value = params[key];
    return typeof value === 'string' ? (name ? encodeURIComponent(value) : value) : token;
  });
  const query = request.url.split('?')[1];
  if (!query) return path;
  const fields = query
    .split('&')
    .map((field) => {
      const name = decodeURIComponent(field.split('=')[0] ?? '');
      return secrets.has(name) ? `${name}=${REDACTED}` : field;
    })
    .join('&');
  return `${path}?${fields}`;
}

/**
 * The app's logger: requests are logged by route, not raw URL (`loggedUrl`). Fastify's own `req`
 * serializer would write `req.url`; the logger's serializers take precedence over it.
 */
export function requestLogger(logger: FastifyBaseLogger): FastifyBaseLogger {
  return logger.child(
    {},
    {
      serializers: {
        req: (request: FastifyRequest) => ({
          method: request.method,
          url: loggedUrl(request, DEBUG_LEVELS.has(logger.level)),
          host: request.host,
          remoteAddress: request.ip,
        }),
      },
    },
  );
}

/** Fastify's request log lines, without the raw URL its default 404 handler puts in the message. */
export class RequestLogController extends LogController {
  override routeNotFound(request: FastifyRequest): void {
    if (this.isLogDisabled(request)) return;
    request.log.info({ req: request }, 'Route not found');
  }
}
