import type { Span } from '@opentelemetry/api';
import type { FastifyRequest } from 'fastify';

const requestSpans = new WeakMap<FastifyRequest, Span>();

/** Called by the Fastify tracing plugin for each traced request. */
export function setRequestSpan(request: FastifyRequest, span: Span): void {
  requestSpans.set(request, span);
}

/** The request's span, while tracing is on. */
export const requestSpan = (request: FastifyRequest): Span | undefined => requestSpans.get(request);
