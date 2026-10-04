import type { FastifyInstance } from 'fastify';

export interface RequestDiagnosticsOptions {
  /** Responses slower than this are logged as warnings. */
  slowMs: number;
  /** Process state worth knowing when a request is slow (pool usage, event-loop delay). */
  snapshot?: () => Record<string, unknown>;
}

/** Long-lived streams end by the client closing them; they are neither slow nor abandoned. */
const STREAMING = /^\/api\/v1\/events(\?|$)/;

/**
 * Logs slow responses, and requests the client gave up on before a response was sent, with a
 * snapshot of process state so stalls can be attributed.
 */
export function registerRequestDiagnostics(
  app: FastifyInstance,
  options: RequestDiagnosticsOptions,
): void {
  app.addHook('onRequest', (request, reply, done) => {
    if (!STREAMING.test(request.url)) {
      let finished = false;
      reply.raw.once('finish', () => {
        finished = true;
      });
      reply.raw.once('close', () => {
        if (finished) return;
        request.log.warn(
          { elapsedMs: Math.round(reply.elapsedTime), ...options.snapshot?.() },
          'Client closed the connection before the response was sent',
        );
      });
    }
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    if (reply.elapsedTime >= options.slowMs && !STREAMING.test(request.url)) {
      request.log.warn(
        { responseTimeMs: Math.round(reply.elapsedTime), ...options.snapshot?.() },
        'Slow request',
      );
    }
    done();
  });
}
