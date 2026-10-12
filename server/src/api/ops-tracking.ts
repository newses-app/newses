import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ClientKind, OpsRecorder } from '../core/ops/recorder.ts';
import { requestSpan } from '../telemetry/request-spans.ts';
import { getInstruments } from '../telemetry/index.ts';

/** Values the apps send in `X-RSS-Client`. */
const APP_CLIENTS = new Set<ClientKind>(['web', 'desktop', 'mobile']);

/** The API a request belongs to, or null for the web app's files and health checks. */
export function clientOf(request: FastifyRequest): ClientKind | null {
  const path = request.url.split('?')[0] ?? '';
  if (path.startsWith('/api/v1/')) {
    const header = request.headers['x-rss-client'];
    return typeof header === 'string' && APP_CLIENTS.has(header as ClientKind)
      ? (header as ClientKind)
      : 'other';
  }
  if (path.startsWith('/reader/api/') || path.startsWith('/api/greader.php')) return 'greader';
  if (path === '/api' || path.startsWith('/api/')) return 'ttrss';
  if (path.startsWith('/public/')) return 'public';
  return null;
}

const requestUsers = new WeakMap<FastifyRequest, number>();

/** Credits the request to a signed-in user, whichever API authenticated it. */
export function attributeUser(request: FastifyRequest, userId: number): void {
  requestUsers.set(request, userId);
  requestSpan(request)?.setAttribute('user.id', String(userId));
}

/**
 * Counts each API request for the Operations page (by client, status, and user) and records the
 * `http.server.request.duration` metric by route.
 */
export function registerOpsTracking(app: FastifyInstance, recorder: OpsRecorder | null): void {
  app.addHook('onRequest', (request, _reply, done) => {
    requestSpan(request)?.setAttribute('rss.client', clientOf(request) ?? 'none');
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url;
    if (route === '/healthz') {
      done();
      return;
    }
    const durationMs = reply.elapsedTime;
    getInstruments().httpDuration.record(durationMs / 1000, {
      'http.request.method': request.method,
      'http.route': route ?? 'unmatched',
      'http.response.status_code': reply.statusCode,
    });
    const client = clientOf(request);
    if (recorder && client) {
      recorder.recordRequest({
        client,
        status: reply.statusCode,
        durationMs,
        userId: requestUsers.get(request) ?? null,
      });
    }
    done();
  });
}
