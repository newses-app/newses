// Playwright's global setup: checks the account the tests sign in with before any test runs, so a
// deployment that cannot pass says why once, instead of failing each test on a missing element,
// and signs it out of the sessions earlier runs left.
import type { FullConfig } from '@playwright/test';
import { credentials } from './login.ts';
import { withAccount } from './sessions.ts';

interface Session {
  user: { role: string; twoFactor: boolean; passwordChangeRequired: boolean };
}

export default async function checkAccount(config: FullConfig): Promise<void> {
  const problems = await withAccount(config.projects[0]?.use.baseURL ?? '', async (api) => {
    const session = await api.get('/api/v1/auth/session');
    if (!session.ok()) {
      throw new Error(`E2E_LOGIN ${credentials.login} needs two-factor sign-in off`);
    }
    const { user } = (await session.json()) as Session;
    const subscriptions = (await (await api.get('/api/v1/subscriptions')).json()) as unknown[];
    return [
      ...(user.role === 'admin' ? [] : ['be an admin (Settings → Users)']),
      ...(user.passwordChangeRequired ? ['have changed its first password'] : []),
      ...(subscriptions.length > 0 ? [] : ['have subscriptions with articles']),
    ];
  });
  if (problems.length > 0) {
    throw new Error(`E2E_LOGIN ${credentials.login} must ${problems.join(', and ')}`);
  }
}
