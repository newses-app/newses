import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { newToken } from '../../core/auth/tokens.ts';
import { DomainError, ThrottledError } from '../../core/errors.ts';
import {
  type CompatAuth,
  type CompatOptions,
  type CompatServices,
  compatSession,
  logUnsupported,
  openAppSession,
  traceCall,
} from './common.ts';

declare module 'fastify' {
  interface FastifyRequest {
    reader: CompatAuth | null;
  }
}

/** Query and form parameters together; repeated names (`i=…&i=…`) keep every value. */
export function readerParams(request: FastifyRequest): URLSearchParams {
  const params = new URLSearchParams(request.url.split('?')[1] ?? '');
  if (request.body instanceof URLSearchParams)
    for (const [name, value] of request.body) params.append(name, value);
  return params;
}

/** The caller's session in a `/reader/api/0` route. */
export function readerSession(request: FastifyRequest): CompatAuth {
  if (!request.reader) throw new Error('Reader route without a session');
  return request.reader;
}

const asObject = (params: URLSearchParams) => {
  const object: Record<string, string | string[]> = {};
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name);
    object[name] = values.length === 1 ? (values[0] ?? '') : values;
  }
  return object;
};

const text = (reply: FastifyReply, status: number, body: string) =>
  reply.code(status).type('text/plain; charset=utf-8').send(body);

export interface GreaderRoutesOptions {
  services: CompatServices;
  options: CompatOptions;
  /** Registers endpoints under `/reader/api/0`, where `request.reader` holds the session. */
  endpoints?: (reader: FastifyInstance) => void;
}

/**
 * Google Reader API: `ClientLogin` with an app password issues an `Auth` token, sent back as
 * `Authorization: GoogleLogin auth=<token>` on every `/reader/api/0` call. Mounted at the root and
 * at `/api/greader.php`, where clients offering only a FreshRSS account type look for it.
 */
export const greaderRoutes: FastifyPluginAsync<GreaderRoutesOptions> = (
  app,
  { services, options, endpoints },
) => {
  // Bodies are form-encoded, whatever clients declare.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
    done(null, new URLSearchParams(String(body)));
  });
  app.addHook('onSend', (_request, reply, payload, done) => {
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
    done(null, payload);
  });
  app.addHook('preHandler', (request, _reply, done) => {
    const path = request.routeOptions.url ?? request.url;
    traceCall(
      request,
      options,
      'greader',
      `${request.method} ${path}`,
      asObject(readerParams(request)),
    );
    done();
  });

  // POST only: a password in a query string would be written to request logs.
  app.post('/accounts/ClientLogin', async (request, reply) => {
    const params = readerParams(request);
    const login = params.get('Email') ?? '';
    const password = params.get('Passwd') ?? '';
    try {
      if (!login || !password) throw new DomainError('invalid_credentials', 'Missing credentials');
      const { token, user, session } = await openAppSession(
        request,
        services.auth,
        login,
        password,
      );
      if (user.passwordChangeRequired) {
        await services.sessions.revoke(user.id, session.id);
        return await text(reply, 403, 'Error=PasswordChangeRequired\n');
      }
      return await text(reply, 200, `SID=${token}\nLSID=null\nAuth=${token}\n`);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      if (err instanceof ThrottledError)
        void reply.header('retry-after', String(err.retryAfterSeconds));
      return text(reply, 401, 'Error=BadAuthentication\n');
    }
  });

  void app.register(
    (reader, _opts, done) => {
      reader.decorateRequest('reader', null);
      reader.addHook('onRequest', async (request, reply) => {
        const token = /^GoogleLogin\s+auth=(\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
        const session = await compatSession(services.sessions, token);
        if (session === 'password_change_required')
          return text(reply, 403, 'Change your password in the web app first\n');
        if (!session) return text(reply, 401, 'Unauthorized\n');
        request.reader = session;
        return undefined;
      });

      // Write calls carry this as `T`; it is not checked, because requests authenticate by
      // header, never by cookie, so there is no cross-site forgery for it to prevent.
      reader.get('/token', (_request, reply) => text(reply, 200, newToken()));
      endpoints?.(reader);
      reader.all('/*', (request, reply) => {
        logUnsupported(request, 'greader', `${request.method} ${request.url.split('?')[0] ?? ''}`);
        return text(reply, 404, 'Not found\n');
      });
      done();
    },
    { prefix: '/reader/api/0' },
  );
  return Promise.resolve();
};
