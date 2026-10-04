import cookie from '@fastify/cookie';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { AuthService } from '../core/auth/auth-service.ts';
import type { SessionService } from '../core/auth/sessions.ts';
import type { UserService } from '../core/auth/users.ts';
import type { FeedServices } from '../core/feeds/index.ts';
import { registerAuth } from './auth.ts';
import { errorHandler } from './errors.ts';
import { adminUserRoutes } from './routes/admin-users.ts';
import { authRoutes } from './routes/auth.ts';
import { feedRoutes } from './routes/feeds.ts';

export type HealthCheck = () => Promise<void>;

export interface ApiServices {
  auth: AuthService;
  sessions: SessionService;
  users: UserService;
  feeds: FeedServices;
}

export interface AppDeps {
  logger: FastifyBaseLogger;
  /** Each check throws when its dependency is unavailable. */
  healthChecks: Record<string, HealthCheck>;
  /** Fastify `trustProxy`: true to trust any proxy, or comma-separated proxy addresses/CIDRs. */
  trustProxy?: boolean | string;
  services?: ApiServices;
}

/** Builds the HTTP app without listening, so it can be mounted by listen() or a Lambda adapter. */
export function buildApp(deps: AppDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    trustProxy: deps.trustProxy ?? false,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);

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

  const services = deps.services;
  if (services) {
    void app.register(cookie);
    void app.register(
      async (api) => {
        registerAuth(api, services.sessions);
        await api.register(authRoutes, services);
        await api.register(adminUserRoutes, services);
        await api.register(feedRoutes, services.feeds);
      },
      { prefix: '/api/v1' },
    );
  }

  return app;
}
