import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

export type HealthCheck = () => Promise<void>;

export interface AppDeps {
  logger: FastifyBaseLogger;
  /** Each check throws when its dependency is unavailable. */
  healthChecks: Record<string, HealthCheck>;
}

/** Builds the HTTP app without listening, so it can be mounted by listen() or a Lambda adapter. */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ loggerInstance: deps.logger });

  app.get('/healthz', async (_request, reply) => {
    const results = await Promise.all(
      Object.entries(deps.healthChecks).map(async ([name, check]) => {
        try {
          await check();
          return [name, 'ok'] as const;
        } catch (err) {
          app.log.warn({ err, check: name }, 'Health check failed');
          return [name, 'error'] as const;
        }
      }),
    );
    const healthy = results.every(([, status]) => status === 'ok');
    return reply
      .code(healthy ? 200 : 503)
      .send({ status: healthy ? 'ok' : 'error', checks: Object.fromEntries(results) });
  });

  return app;
}
