import { timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import type { LightMyRequestResponse } from 'fastify';

export interface ApiHandlerDeps<R> {
  /** The app behind `@fastify/aws-lambda`. */
  proxy: (event: APIGatewayProxyEventV2, context: Context) => Promise<R>;
  /** The value CloudFront sends as `x-origin-verify`. */
  originSecret: string;
  /** Whether a request used the database since the last reset (`trackPoolUse`). */
  database: { used(): boolean; reset(): void };
  /** Writes the statistics and audit kept in memory. */
  flush: () => Promise<unknown>;
}

/** Favicons are binary, so they go base64-encoded, as does anything compressed; JSON and text stay plain. */
export function binaryResponse(response: Pick<LightMyRequestResponse, 'headers'>): boolean {
  return (
    /^image\//.test(response.headers['content-type'] ?? '') ||
    response.headers['content-encoding'] !== undefined
  );
}

/** Whether the request came through CloudFront, which adds the origin secret. */
export function fromCloudFront(event: APIGatewayProxyEventV2, secret: Buffer): boolean {
  const given = Buffer.from(event.headers['x-origin-verify'] ?? '');
  return given.length === secret.length && timingSafeEqual(given, secret);
}

/**
 * The API function's handler: refuses requests that bypass CloudFront, and after each request that
 * used the database, writes the statistics and audit before the container may be frozen. The
 * others open no connection to write them; their counts wait in memory.
 */
export function createApiHandler<R>(deps: ApiHandlerDeps<R>) {
  const secret = Buffer.from(deps.originSecret);
  return async (
    event: APIGatewayProxyEventV2,
    context: Context,
  ): Promise<R | { statusCode: 403; body: '' }> => {
    if (!fromCloudFront(event, secret)) return { statusCode: 403, body: '' };
    const response = await deps.proxy(event, context);
    if (deps.database.used()) {
      await deps.flush();
      deps.database.reset();
    }
    return response;
  };
}
