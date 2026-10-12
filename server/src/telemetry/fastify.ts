import { FastifyOtelInstrumentation } from '@fastify/otel';
import { setRequestSpan } from './request-spans.ts';

/**
 * Fastify plugin that traces each request as `METHOD /route/:pattern`. The raw URL is never
 * recorded: query strings and proxied image paths may carry tokens. Health checks are skipped.
 * Loaded only when tracing is on, as `@fastify/otel` is large.
 */
export function fastifyTracing() {
  const instrumentation = new FastifyOtelInstrumentation({
    ignorePaths: (route) => route.url === '/healthz',
    instrumentHooks: false,
    requestHook: (span, request) => {
      const route = request.routeOptions.url ?? 'unmatched';
      span.updateName(`${request.method} ${route}`);
      span.setAttribute('url.path', route);
      setRequestSpan(request, span);
    },
  });
  return instrumentation.plugin();
}
