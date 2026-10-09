import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { AppPasswordService } from '../core/auth/app-passwords.ts';
import type { AuthService } from '../core/auth/auth-service.ts';
import type { SessionService } from '../core/auth/sessions.ts';
import type { TwoFactorService } from '../core/auth/two-factor.ts';
import type { UserService } from '../core/auth/users.ts';
import type { EntryServices } from '../core/entries/index.ts';
import type { FeedServices } from '../core/feeds/index.ts';
import type { Realtime } from '../core/ports.ts';
import type { PrefsService } from '../core/prefs.ts';
import { INSECURE_SESSION_COOKIE, registerAuth, SESSION_COOKIE } from './auth.ts';
import { greaderRoutes } from './compat/greader.ts';
import { greaderEndpoints } from './compat/greader-ops.ts';
import { ttrssRoutes } from './compat/ttrss.ts';
import { feedIconRoutes, ttrssConfig, ttrssOps } from './compat/ttrss-ops.ts';
import { errorHandler } from './errors.ts';
import { adminUserRoutes } from './routes/admin-users.ts';
import { authRoutes } from './routes/auth.ts';
import { entryRoutes } from './routes/entries.ts';
import { eventRoutes, type EventStreamOptions, noEventRoutes } from './routes/events.ts';
import { feedRoutes } from './routes/feeds.ts';
import { imageRoutes } from './routes/images.ts';
import { labelRoutes } from './routes/labels.ts';
import { tagRoutes } from './routes/tags.ts';
import { prefsRoutes } from './routes/prefs.ts';
import { legacyPublicRoutes, publicRoutes } from './routes/public.ts';
import { sharingRoutes } from './routes/sharing.ts';
import {
  registerRequestDiagnostics,
  type RequestDiagnosticsOptions,
} from './request-diagnostics.ts';
import { registerWeb } from './web.ts';

export type HealthCheck = () => Promise<void>;

export interface ApiServices {
  auth: AuthService;
  sessions: SessionService;
  users: UserService;
  twoFactor: TwoFactorService;
  appPasswords: AppPasswordService;
  feeds: FeedServices;
  entries: EntryServices;
  prefs: PrefsService;
  realtime: Realtime;
}

export interface AppDeps {
  logger: FastifyBaseLogger;
  /** Each check throws when its dependency is unavailable. */
  healthChecks: Record<string, HealthCheck>;
  /** Fastify `trustProxy`: true for any proxy, a hop count, or comma-separated addresses/CIDRs. */
  trustProxy?: boolean | number | string;
  services?: ApiServices;
  /** Event stream settings (tests override timings); false where streams cannot be held open. */
  events?: Omit<EventStreamOptions, 'realtime'> | false;
  /** Origin of public links (published feeds); null or omitted uses each request's origin. */
  publicUrl?: string | null;
  /** Log every compatibility-API call, credentials redacted. */
  compatTrace?: boolean;
  /** Directory of the built web app to serve at `/`; omitted when the SPA is hosted elsewhere. */
  webDir?: string | null;
  /** Logging of slow and abandoned requests; defaults to 2 s without a state snapshot. */
  diagnostics?: Partial<RequestDiagnosticsOptions>;
}

/** A hop count trusts that many proxies in front of the server, nearest first. */
const trustProxy = (trust: boolean | number | string) =>
  typeof trust === 'number' ? (_address: string, hop: number) => hop < trust : trust;

/** Builds the HTTP app without listening, so it can be mounted by listen() or a Lambda adapter. */
export function buildApp(deps: AppDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    // Proxied image paths carry the encoded image URL.
    routerOptions: { maxParamLength: 8192 },
    trustProxy: trustProxy(deps.trustProxy ?? false),
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  registerRequestDiagnostics(app, { slowMs: 2000, ...deps.diagnostics });
  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.header('x-content-type-options', 'nosniff');
    // Reverse proxies and CloudFront may add it too; the app does not rely on them.
    if (request.protocol === 'https') {
      void reply.header('strict-transport-security', 'max-age=31536000');
    }
    // API responses carry per-user data; routes that may be cached set their own cache-control.
    if (request.url.startsWith('/api/') && !reply.hasHeader('cache-control')) {
      void reply.header('cache-control', 'no-store');
    }
    done(null, payload);
  });

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
    void app.register(swagger, {
      openapi: {
        info: { title: 'rss-reader API', version: '1' },
        components: {
          securitySchemes: {
            cookie: {
              type: 'apiKey',
              in: 'cookie',
              name: SESSION_COOKIE,
              description: `\`${INSECURE_SESSION_COOKIE}\` when the server is reached over plain HTTP`,
            },
            bearer: { type: 'http', scheme: 'bearer' },
          },
        },
        security: [{ cookie: [] }, { bearer: [] }],
      },
      transform: jsonSchemaTransform,
    });
    void app.register(
      async (api) => {
        registerAuth(api, services.sessions);
        api.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());
        await api.register(authRoutes, { ...services, publicUrl: deps.publicUrl ?? null });
        await api.register(adminUserRoutes, services);
        await api.register(feedRoutes, services.feeds);
        await api.register(entryRoutes, {
          ...services.entries,
          prefs: services.prefs,
          images: services.feeds.images,
        });
        await api.register(labelRoutes, { labels: services.entries.labels });
        await api.register(tagRoutes, { tags: services.entries.tags });
        await api.register(sharingRoutes, services.entries);
        await api.register(imageRoutes, { images: services.feeds.images });
        await api.register(prefsRoutes, { prefs: services.prefs });
        if (deps.events === false) await api.register(noEventRoutes);
        else await api.register(eventRoutes, { realtime: services.realtime, ...deps.events });
      },
      { prefix: '/api/v1' },
    );
    void app.register(publicRoutes, {
      prefix: '/public',
      entries: services.entries.entries,
      accessKeys: services.entries.accessKeys,
      prefs: services.prefs,
      images: services.feeds.images,
      publicUrl: deps.publicUrl ?? null,
    });
    void app.register(legacyPublicRoutes);
    const compat = {
      services: { auth: services.auth, sessions: services.sessions },
      options: { trace: deps.compatTrace ?? false },
    };
    const ttrssDeps = { entries: services.entries, feeds: services.feeds, prefs: services.prefs };
    void app.register(ttrssRoutes, {
      ...compat,
      ops: ttrssOps(ttrssDeps),
      loginConfig: ttrssConfig(ttrssDeps),
    });
    void app.register(feedIconRoutes, ttrssDeps);
    const greader = {
      ...compat,
      endpoints: greaderEndpoints({ ...ttrssDeps, publicUrl: deps.publicUrl ?? null }),
    };
    void app.register(greaderRoutes, greader);
    void app.register(greaderRoutes, { ...greader, prefix: '/api/greader.php' });
  }

  if (deps.webDir) registerWeb(app, deps.webDir);

  return app;
}
