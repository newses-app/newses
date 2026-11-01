import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { DomainError, ThrottledError } from '../core/errors.ts';
import { errorHandler } from './errors.ts';

function appThrowing(err: Error) {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  app.get('/fail', () => {
    throw err;
  });
  app.post('/echo', () => 'ok');
  return app;
}

const failure = async (err: Error) => {
  const response = await appThrowing(err).inject({ method: 'GET', url: '/fail' });
  return { status: response.statusCode, body: response.json<unknown>() };
};

describe('errorHandler', () => {
  it('adds the reason and params an error carries', async () => {
    const err = new DomainError('conflict', 'A label named "News" already exists', {
      reason: 'label_name_taken',
      params: { name: 'News' },
    });
    expect(await failure(err)).toEqual({
      status: 409,
      body: {
        error: 'conflict',
        message: 'A label named "News" already exists',
        reason: 'label_name_taken',
        params: { name: 'News' },
      },
    });
  });

  it('adds a reason without params', async () => {
    const err = new DomainError('conflict', 'Already subscribed to this feed', {
      reason: 'already_subscribed',
    });
    expect(await failure(err)).toEqual({
      status: 409,
      body: {
        error: 'conflict',
        message: 'Already subscribed to this feed',
        reason: 'already_subscribed',
      },
    });
  });

  it('keeps the plain shape for errors without a reason', async () => {
    expect(await failure(new DomainError('not_found', 'Label not found'))).toEqual({
      status: 404,
      body: { error: 'not_found', message: 'Label not found' },
    });
  });

  it('adds the reason of a throttled error, and Retry-After', async () => {
    const err = new ThrottledError(30, 'The feed host asked not to be fetched again yet', {
      reason: 'feed_host_paused',
    });
    const response = await appThrowing(err).inject({ method: 'GET', url: '/fail' });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('30');
    expect(response.json()).toMatchObject({ error: 'throttled', reason: 'feed_host_paused' });
  });

  it('gives a body over the limit a reason', async () => {
    const response = await appThrowing(new Error('unused')).inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'x'.repeat(1024 * 1024 + 1) }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ reason: 'body_too_large' });
  });
});
