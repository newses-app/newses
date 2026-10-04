import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { DomainError, type DomainErrorCode, ThrottledError } from '../core/errors.ts';

/** Request-level failures raised by the API itself (authentication, authorisation, CSRF). */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const DOMAIN_STATUS: Record<DomainErrorCode, number> = {
  invalid_credentials: 401,
  throttled: 429,
  not_found: 404,
  conflict: 409,
  last_admin: 409,
  invalid_input: 400,
  feed_not_found: 422,
  fetch_failed: 502,
  resync_required: 410,
};

export function errorHandler(err: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ThrottledError) {
    void reply.header('retry-after', String(err.retryAfterSeconds));
  }
  if (err instanceof DomainError) {
    return reply.code(DOMAIN_STATUS[err.code]).send({ error: err.code, message: err.message });
  }
  if (err instanceof HttpError) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message });
  }
  if (hasZodFastifySchemaValidationErrors(err)) {
    return reply.code(400).send({ error: 'validation', message: err.message });
  }
  if (err.statusCode !== undefined && err.statusCode < 500) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message });
  }
  request.log.error({ err }, 'Unhandled error');
  return reply.code(500).send({ error: 'internal', message: 'Internal server error' });
}
