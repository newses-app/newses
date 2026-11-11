import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTH_FEED_ACCOUNTS,
  type AuthFeedServer,
  startAuthFeedServer,
} from './auth-feed-server.ts';

let server: AuthFeedServer;

beforeAll(async () => {
  server = await startAuthFeedServer({ now: () => 1_700_000_000_000 });
});
afterAll(() => server.close());

const basic = (login: string, password: string) =>
  `Basic ${Buffer.from(`${login}:${password}`, 'utf8').toString('base64')}`;

describe('auth feed server', () => {
  it('challenges requests without valid credentials', async () => {
    const none = await fetch(`${server.url}/basic.xml`);
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain('charset="UTF-8"');
    const wrong = await fetch(`${server.url}/basic.xml`, {
      headers: { authorization: basic('reader', 'nope') },
    });
    expect(wrong.status).toBe(401);
  });

  it('serves the feed to every account, UTF-8 passwords with colons included', async () => {
    for (const [login, password] of Object.entries(AUTH_FEED_ACCOUNTS)) {
      const res = await fetch(`${server.url}/basic.xml`, {
        headers: { authorization: basic(login, password) },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(`Fetched as ${login}.`);
    }
  });

  it('answers conditional requests with 304 once authenticated', async () => {
    const authorization = basic('reader', 'secret');
    const first = await fetch(`${server.url}/basic.xml`, { headers: { authorization } });
    const etag = first.headers.get('etag') ?? '';
    const again = await fetch(`${server.url}/basic.xml`, {
      headers: { authorization, 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
    const anonymous = await fetch(`${server.url}/basic.xml`, {
      headers: { 'if-none-match': etag },
    });
    expect(anonymous.status).toBe(401);
  });

  it('refuses valid credentials on the forbidden feed', async () => {
    const res = await fetch(`${server.url}/forbidden.xml`, {
      headers: { authorization: basic('reader', 'secret') },
    });
    expect(res.status).toBe(403);
  });

  it('redirects within its origin and to the other one', async () => {
    const same = await fetch(`${server.url}/redirect.xml`, { redirect: 'manual' });
    expect(same.headers.get('location')).toBe('/basic.xml');
    const away = await fetch(`${server.url}/elsewhere.xml`, { redirect: 'manual' });
    expect(away.headers.get('location')).toBe(`${server.otherUrl}/leak.xml`);
  });

  it('says in the other origin’s feed whether credentials reached it', async () => {
    const clean = await fetch(`${server.otherUrl}/leak.xml`);
    expect(await clean.text()).toContain('No credentials arrived');
    const leaked = await fetch(`${server.otherUrl}/leak.xml`, {
      headers: { authorization: basic('reader', 'secret') },
    });
    expect(await leaked.text()).toContain('Credentials leaked');
  });
});
