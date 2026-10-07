// Contract-test helpers for the compatibility APIs: requests shaped as clients send them, built
// from the public API documentation and traffic observed from real clients (ADR 0009).
import type { buildApp } from '../api/app.ts';

type App = ReturnType<typeof buildApp>;

export interface TtrssResponse<T = Record<string, unknown>> {
  seq: number;
  status: 0 | 1;
  content: T;
}

/** One TTRSS API call: a JSON POST to `path`, as the TTRSS Android app sends it. */
export async function ttrss<T = Record<string, unknown>>(
  app: App,
  params: Record<string, unknown>,
  path = '/api/',
): Promise<TtrssResponse<T>> {
  const response = await app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json; charset=utf-8', 'user-agent': 'contract-test' },
    payload: JSON.stringify(params),
  });
  if (response.statusCode !== 200)
    throw new Error(`TTRSS call answered ${String(response.statusCode)}: ${response.body}`);
  return response.json<TtrssResponse<T>>();
}

/** Logs in through the TTRSS API and returns the session id. */
export async function ttrssLogin(app: App, user: string, password: string): Promise<string> {
  const response = await ttrss<{ session_id: string }>(app, { op: 'login', user, password });
  if (response.status !== 0) throw new Error(`TTRSS login failed: ${JSON.stringify(response)}`);
  return response.content.session_id;
}

export interface ReaderRequest {
  /** `Auth` token from ClientLogin. */
  token?: string;
  query?: Record<string, string | string[]>;
  /** Form-encoded body; repeated names as arrays. */
  form?: Record<string, string | string[]>;
  /** `/api/greader.php` for FreshRSS-style clients. */
  prefix?: string;
}

const encode = (values: Record<string, string | string[]>) => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values))
    for (const item of Array.isArray(value) ? value : [value]) params.append(name, item);
  return params.toString();
};

/** One Google Reader API call, authenticated with `GoogleLogin auth=` when a token is given. */
export function reader(
  app: App,
  method: 'GET' | 'POST',
  path: string,
  request: ReaderRequest = {},
) {
  const query = request.query ? `?${encode(request.query)}` : '';
  return app.inject({
    method,
    url: `${request.prefix ?? ''}${path}${query}`,
    headers: {
      'user-agent': 'contract-test',
      ...(request.token && { authorization: `GoogleLogin auth=${request.token}` }),
      ...(request.form && { 'content-type': 'application/x-www-form-urlencoded' }),
    },
    ...(request.form && { payload: encode(request.form) }),
  });
}

/** Logs in through ClientLogin and returns the `Auth` token. */
export async function readerLogin(
  app: App,
  login: string,
  password: string,
  prefix = '',
): Promise<string> {
  const response = await reader(app, 'POST', '/accounts/ClientLogin', {
    form: { Email: login, Passwd: password },
    prefix,
  });
  const token = /^Auth=(.+)$/m.exec(response.body)?.[1];
  if (response.statusCode !== 200 || !token)
    throw new Error(`ClientLogin failed: ${String(response.statusCode)} ${response.body}`);
  return token;
}
