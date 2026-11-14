import { type APIRequestContext, request } from '@playwright/test';
import { credentials } from './login.ts';

/**
 * Signs the test account in through the API, and out of every session once `use` is done: each
 * test signs in anew, and sessions left open pile up in Settings → Account, whose list of them
 * grows until the page is too heavy to load and scan.
 */
export async function withAccount<T>(
  baseURL: string,
  use: (api: APIRequestContext) => Promise<T>,
): Promise<T> {
  const api = await request.newContext({ baseURL });
  try {
    const login = await api.post('/api/v1/auth/login', { data: credentials });
    if (!login.ok()) {
      throw new Error(
        `E2E_LOGIN ${credentials.login} cannot sign in to ${baseURL} (HTTP ${String(login.status())})`,
      );
    }
    const result = await use(api);
    await signOutEverywhere(api);
    return result;
  } finally {
    await api.dispose();
  }
}

async function signOutEverywhere(api: APIRequestContext): Promise<void> {
  const { csrfToken } = (await (await api.get('/api/v1/auth/session')).json()) as {
    csrfToken: string | null;
  };
  const headers = { 'x-csrf-token': csrfToken ?? '' };
  const sessions = (await (await api.get('/api/v1/auth/sessions')).json()) as {
    id: number;
    current: boolean;
  }[];
  for (const { id } of sessions.filter((s) => !s.current))
    await api.delete(`/api/v1/auth/sessions/${String(id)}`, { headers });
  await api.post('/api/v1/auth/logout', { headers });
}
