// Feeds behind HTTP Basic authentication, for developing and testing HTTP-auth feeds (#1) without
// a third-party service. Tests start it with `startAuthFeedServer`; for the app, run
// `pnpm --filter @newses/server feeds:auth` and subscribe to the URLs it prints.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** Login and password pairs the protected feeds accept: ASCII, and UTF-8 with a colon. */
export const AUTH_FEED_ACCOUNTS: Readonly<Record<string, string>> = {
  reader: 'secret',
  josé: 'pä:ss wörd',
};

const REALM = 'Basic realm="Newses test feeds", charset="UTF-8"';

export interface AuthFeedServerOptions {
  port?: number;
  host?: string;
  /** Minutes between new items; each feed keeps the latest 10. */
  everyMinutes?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface AuthFeedServer {
  /** The protected server, e.g. `http://127.0.0.1:8090`. */
  url: string;
  /** Another origin (the next port), where `/elsewhere.xml` redirects. */
  otherUrl: string;
  close(): Promise<void>;
}

type Credentials = { login: string; password: string } | null | 'malformed';

function credentials(req: IncomingMessage): Credentials {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header);
  if (!match?.[1]) return 'malformed';
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return 'malformed';
  return { login: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  '"': '&quot;',
};
const escapeXml = (text: string) => text.replace(/[<>&"]/g, (c) => XML_ENTITIES[c] ?? c);

function rss(title: string, link: string, slot: number, slotMs: number, note: string): string {
  const items = Array.from({ length: 10 }, (_, i) => {
    const n = slot - i;
    const date = new Date(n * slotMs).toUTCString();
    return `<item><title>${escapeXml(`${title} #${String(n)}`)}</title><link>${escapeXml(`${link}#${String(n)}`)}</link><guid isPermaLink="false">${escapeXml(`${link}#${String(n)}`)}</guid><pubDate>${date}</pubDate><description>${escapeXml(note)}</description></item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeXml(title)}</title><link>${escapeXml(link)}</link><description>${escapeXml(note)}</description>${items.join('')}</channel></rss>`;
}

const INDEX = (url: string, otherUrl: string) => `Newses test feeds
Accounts: ${Object.entries(AUTH_FEED_ACCOUNTS)
  .map(([login, password]) => `${login} / ${password}`)
  .join(', ')}

${url}/open.xml         no authentication
${url}/basic.xml        Basic auth; ETag and Last-Modified, 304 when unchanged
${url}/forbidden.xml    401 without credentials, 403 with valid ones
${url}/redirect.xml     301 to /basic.xml on this origin (credentials resent)
${url}/elsewhere.xml    302 to ${otherUrl}/leak.xml (credentials must not follow)
`;

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

const text = (status: number, body: string, headers: Record<string, string> = {}): Reply => ({
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  body,
});

/** Who a request came as, for the log and the feed's items. */
function describe(given: Credentials, valid: boolean): string {
  if (given === null) return 'no credentials';
  if (given === 'malformed') return 'malformed credentials';
  return valid ? `as ${given.login}` : `wrong credentials for ${given.login}`;
}

/** Starts the protected server and the other origin; port 0 picks free ports (tests). */
export async function startAuthFeedServer(
  options: AuthFeedServerOptions = {},
): Promise<AuthFeedServer> {
  const host = options.host ?? '127.0.0.1';
  const slotMs = (options.everyMinutes ?? 5) * 60_000;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);

  // Origins as the client addressed them (e.g. host.docker.internal), not as bound.
  const origin = (req: IncomingMessage, server: Server) => {
    const name = (req.headers.host ?? host).replace(/:\d+$/, '');
    return `http://${name}:${String((server.address() as AddressInfo).port)}`;
  };

  const feed = (req: IncomingMessage, link: string, note: string): Reply => {
    const slot = Math.floor(now() / slotMs);
    const headers = {
      etag: `"${String(slot)}"`,
      'last-modified': new Date(slot * slotMs).toUTCString(),
    };
    if (
      req.headers['if-none-match'] === headers.etag ||
      req.headers['if-modified-since'] === headers['last-modified']
    ) {
      return { status: 304, headers };
    }
    const title = new URL(link).pathname.slice(1).replace(/\.xml$/, '');
    return {
      status: 200,
      headers: { 'content-type': 'application/rss+xml; charset=utf-8', ...headers },
      body: rss(`Test feed: ${title}`, link, slot, slotMs, note),
    };
  };

  const serve =
    (route: (req: IncomingMessage, path: string) => { who: string; reply: Reply }) =>
    (req: IncomingMessage, res: ServerResponse) => {
      const { who, reply } = route(req, (req.url ?? '/').split('?')[0] ?? '/');
      log(
        `${req.method ?? 'GET'} ${req.headers.host ?? ''}${req.url ?? ''} ${who} → ${String(reply.status)}`,
      );
      res
        .writeHead(reply.status, reply.headers)
        .end(req.method === 'HEAD' ? undefined : reply.body);
    };

  const main: Server = createServer(
    serve((req, path) => {
      const self = origin(req, main);
      const given = credentials(req);
      const valid =
        given !== null &&
        given !== 'malformed' &&
        Object.hasOwn(AUTH_FEED_ACCOUNTS, given.login) &&
        AUTH_FEED_ACCOUNTS[given.login] === given.password;
      const who = describe(given, valid);
      const challenge = text(401, 'Unauthorized\n', { 'www-authenticate': REALM });
      const reply = (): Reply => {
        switch (path) {
          case '/':
            return text(200, INDEX(self, origin(req, elsewhere)));
          case '/open.xml':
            return feed(req, `${self}/open.xml`, 'Needs no credentials.');
          case '/basic.xml':
            return valid ? feed(req, `${self}/basic.xml`, `Fetched ${who}.`) : challenge;
          case '/forbidden.xml':
            return valid ? text(403, 'Forbidden\n') : challenge;
          case '/redirect.xml':
            return { status: 301, headers: { location: '/basic.xml' } };
          case '/elsewhere.xml':
            return { status: 302, headers: { location: `${origin(req, elsewhere)}/leak.xml` } };
          default:
            return text(404, 'Not found\n');
        }
      };
      return { who, reply: reply() };
    }),
  );

  // The other origin serves an open feed whose items say whether credentials leaked to it.
  const elsewhere: Server = createServer(
    serve((req, path) => {
      const leaked = req.headers.authorization !== undefined;
      const who = leaked ? 'LEAKED CREDENTIALS' : 'no credentials';
      if (path !== '/leak.xml') return { who, reply: text(404, 'Not found\n') };
      const note = leaked
        ? 'Credentials leaked: the redirect from another origin carried an Authorization header.'
        : 'No credentials arrived from the redirect.';
      return { who, reply: feed(req, `${origin(req, elsewhere)}/leak.xml`, note) };
    }),
  );

  const listen = (server: Server, port: number) =>
    new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        resolve((server.address() as AddressInfo).port);
      });
    });
  const mainPort = await listen(main, options.port ?? 0);
  const otherPort = await listen(elsewhere, options.port ? options.port + 1 : 0);
  const shown = host === '0.0.0.0' ? 'localhost' : host;
  const url = `http://${shown}:${String(mainPort)}`;
  const otherUrl = `http://${shown}:${String(otherPort)}`;

  const close = (server: Server) =>
    new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  return {
    url,
    otherUrl,
    close: () => Promise.all([close(main), close(elsewhere)]).then(() => undefined),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '8090' },
      host: { type: 'string', default: '0.0.0.0' },
      every: { type: 'string', default: '5' },
    },
  });
  const server = await startAuthFeedServer({
    port: Number(values.port),
    host: values.host,
    everyMinutes: Number(values.every),
    log: (line) => {
      console.log(`${new Date().toISOString()} ${line}`);
    },
  });
  console.log(INDEX(server.url, server.otherUrl));
  console.log(
    'From the Docker stack: use host.docker.internal for localhost, and set FETCH_ALLOW_PRIVATE_NETWORKS=true in docker/.env.',
  );
}
