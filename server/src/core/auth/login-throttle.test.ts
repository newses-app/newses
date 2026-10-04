import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../db/client.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { ThrottledError } from '../errors.ts';
import { lockSeconds, LoginThrottle } from './login-throttle.ts';

let database: TestDatabase;
let now = new Date('2026-10-04T12:00:00Z');
let throttle: LoginThrottle;

beforeAll(async () => {
  database = await createTestDatabase();
  throttle = new LoginThrottle(createDb(database.pool), () => now);
});

afterAll(async () => {
  await database.drop();
});

const advance = (seconds: number) => {
  now = new Date(now.getTime() + seconds * 1000);
};

describe('lockSeconds', () => {
  it('doubles past the threshold and caps at 15 minutes', () => {
    const rule = { threshold: 5 };
    expect([4, 5, 6, 7, 10].map((n) => lockSeconds(n, rule))).toEqual([0, 1, 2, 4, 32]);
    expect(lockSeconds(40, rule)).toBe(900);
  });
});

describe('LoginThrottle', () => {
  const rule = { threshold: 3 };

  it('locks a key after the threshold with growing delays', async () => {
    for (let i = 0; i < 2; i++) await throttle.recordFailure('login:a', rule);
    await throttle.check(['login:a']);

    await throttle.recordFailure('login:a', rule);
    await expect(throttle.check(['login:a'])).rejects.toMatchObject({ retryAfterSeconds: 1 });

    advance(1);
    await throttle.check(['login:a']);
    await throttle.recordFailure('login:a', rule);
    const err: unknown = await throttle.check(['login:a', 'ip:x']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ThrottledError);
    expect((err as ThrottledError).retryAfterSeconds).toBe(2);
  });

  it('clears a key on reset', async () => {
    for (let i = 0; i < 3; i++) await throttle.recordFailure('login:b', rule);
    await expect(throttle.check(['login:b'])).rejects.toThrow(ThrottledError);
    await throttle.reset('login:b');
    await throttle.check(['login:b']);
  });
});
