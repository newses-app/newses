import type { FastifyPluginAsync } from 'fastify';
import type { Realtime, RealtimeEvent } from '../../core/ports.ts';
import { requireAuth, requireUser } from '../auth.ts';

export interface EventStreamOptions {
  realtime: Realtime;
  /** Comment line interval; keeps proxies (nginx: 60 s read timeout) from closing the stream. */
  heartbeatMs?: number;
  /** Events of one type arriving within this window are sent once. */
  coalesceMs?: number;
  /** Streams end after this long; clients reconnect, re-checking their session. */
  maxDurationMs?: number;
}

/** Server-sent events: per-user invalidation signals (`counters`). Clients refetch on receipt. */
export const eventRoutes: FastifyPluginAsync<EventStreamOptions> = (app, options) => {
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  const coalesceMs = options.coalesceMs ?? 1000;
  const maxDurationMs = options.maxDurationMs ?? 30 * 60_000;

  app.get('/events', { preHandler: requireUser }, (request, reply) => {
    const userId = requireAuth(request).user.id;
    reply.hijack();
    const res = reply.raw;
    // Headers set before the hijack, such as CORS for the apps.
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) res.setHeader(name, value);
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // nginx (incl. nginx-proxy) buffers proxied responses unless told not to.
      'x-accel-buffering': 'no',
    });
    res.write('retry: 5000\n\n');

    const pending = new Map<RealtimeEvent['type'], NodeJS.Timeout>();
    const unsubscribe = options.realtime.subscribe(userId, (event) => {
      if (pending.has(event.type)) return;
      pending.set(
        event.type,
        setTimeout(() => {
          pending.delete(event.type);
          res.write(`event: ${event.type}\ndata: {}\n\n`);
        }, coalesceMs),
      );
    });
    const heartbeat = setInterval(() => res.write(':\n\n'), heartbeatMs);
    const expiry = setTimeout(() => res.end(), maxDurationMs);
    res.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
      clearTimeout(expiry);
      for (const timer of pending.values()) clearTimeout(timer);
    });
  });

  return Promise.resolve();
};

/** Where streams cannot be held open: 204 tells EventSource not to reconnect, so clients poll. */
export const noEventRoutes: FastifyPluginAsync = (app) => {
  app.get('/events', { schema: { hide: true } }, (_request, reply) => reply.code(204).send());
  return Promise.resolve();
};
