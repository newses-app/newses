import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { DomainError } from '../../core/errors.ts';
import {
  type CompatAuth,
  type CompatOptions,
  type CompatServices,
  compatSession,
  logUnsupported,
  openAppSession,
  traceCall,
} from './common.ts';

/** API level reported to clients, which enable features by it. */
export const TTRSS_API_LEVEL = 20;
export const TTRSS_VERSION = '1.0 (rss-reader)';

export type TtrssErrorCode =
  'NOT_LOGGED_IN' | 'LOGIN_ERROR' | 'API_DISABLED' | 'UNKNOWN_METHOD' | 'INCORRECT_USAGE';

/** A failure answered as `{"status": 1, "content": {"error": code, …}}`. */
export class TtrssError extends Error {
  readonly code: TtrssErrorCode;
  readonly extra: Record<string, unknown>;

  constructor(code: TtrssErrorCode, extra: Record<string, unknown> = {}) {
    super(code);
    this.code = code;
    this.extra = extra;
  }
}

export type TtrssParams = Record<string, unknown>;

export interface TtrssContext {
  request: FastifyRequest;
  params: TtrssParams;
  /** The caller's session; null only for public ops. */
  auth: CompatAuth | null;
}

export interface TtrssOp {
  /** Runs without a session. */
  public?: boolean;
  run(context: TtrssContext): unknown;
}

export type TtrssOps = Record<string, TtrssOp>;

/** The caller's session in an op that requires one. */
export function sessionOf(context: TtrssContext): CompatAuth {
  if (!context.auth) throw new TtrssError('NOT_LOGGED_IN');
  return context.auth;
}

/** A string parameter; numbers are accepted as text, as clients send either. */
export function stringParam(params: TtrssParams, name: string): string | undefined {
  const value = params[name];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/**
 * Request parameters from the POST body. TTRSS reads a JSON body whatever its content type; some
 * clients send form-encoded bodies, so those are accepted too. Query strings are ignored, so
 * passwords never travel in URLs, which are logged.
 */
function readParams(request: FastifyRequest): TtrssParams {
  const body = typeof request.body === 'string' ? request.body.trim() : '';
  if (!body) return {};
  if (!body.startsWith('{')) return Object.fromEntries(new URLSearchParams(body));
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new TtrssError('INCORRECT_USAGE');
  return parsed as TtrssParams;
}

/** Login, logout, and API information. */
function sessionOps({ auth, sessions }: CompatServices): TtrssOps {
  return {
    login: {
      public: true,
      async run({ request, params }) {
        const login = stringParam(params, 'user');
        const password = stringParam(params, 'password');
        if (!login || !password) throw new TtrssError('LOGIN_ERROR');
        let result;
        try {
          result = await openAppSession(request, auth, login, password);
        } catch (err) {
          if (err instanceof DomainError) throw new TtrssError('LOGIN_ERROR');
          throw err;
        }
        if (result.user.passwordChangeRequired) {
          await sessions.revoke(result.user.id, result.session.id);
          throw new TtrssError('API_DISABLED');
        }
        return { session_id: result.token, api_level: TTRSS_API_LEVEL };
      },
    },
    logout: {
      async run(context) {
        const { user, session } = sessionOf(context);
        await sessions.revoke(user.id, session.id);
        return { status: 'OK' };
      },
    },
    isLoggedIn: {
      public: true,
      async run({ params }) {
        const session = await compatSession(sessions, stringParam(params, 'sid'));
        return { status: session !== null && session !== 'password_change_required' };
      },
    },
    getApiLevel: { run: () => ({ level: TTRSS_API_LEVEL }) },
    getVersion: { run: () => ({ version: TTRSS_VERSION }) },
  };
}

export interface TtrssRoutesOptions {
  services: CompatServices;
  options: CompatOptions;
  /** Ops beyond the session ops. */
  ops?: TtrssOps;
}

/**
 * TTRSS-compatible API at `/api/` (and `/api/index.php`): one POST per call naming its `op`,
 * answered with HTTP 200 and `{seq, status, content}`, status 1 carrying an error code.
 */
export const ttrssRoutes: FastifyPluginAsync<TtrssRoutesOptions> = (
  app,
  { services, options, ops = {} },
) => {
  const all: TtrssOps = { ...ops, ...sessionOps(services) };

  // Bodies are parsed by the handler, whatever their declared type.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
    done(null, body);
  });

  async function handle(request: FastifyRequest) {
    let seq = 0;
    try {
      const params = readParams(request);
      seq = Number.parseInt(stringParam(params, 'seq') ?? '0', 10) || 0;
      const name = stringParam(params, 'op') ?? '';
      traceCall(request, options, 'ttrss', name, params);
      const op = Object.hasOwn(all, name) ? all[name] : undefined;
      if (!op) {
        logUnsupported(request, 'ttrss', name);
        throw new TtrssError('UNKNOWN_METHOD', { method: name });
      }
      let auth: CompatAuth | null = null;
      if (!op.public) {
        const session = await compatSession(services.sessions, stringParam(params, 'sid'));
        if (session === 'password_change_required') throw new TtrssError('API_DISABLED');
        if (!session) throw new TtrssError('NOT_LOGGED_IN');
        auth = session;
      }
      return { seq, status: 0, content: await op.run({ request, params, auth }) };
    } catch (err) {
      if (err instanceof TtrssError)
        return { seq, status: 1, content: { error: err.code, ...err.extra } };
      if (err instanceof SyntaxError || err instanceof DomainError)
        return { seq, status: 1, content: { error: 'INCORRECT_USAGE' } };
      throw err;
    }
  }

  for (const url of ['/api', '/api/', '/api/index.php'])
    app.post(url, (request) => handle(request));
  return Promise.resolve();
};
