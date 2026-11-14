// Playwright's global teardown: signs the test account out of the sessions the run's tests opened.
import type { FullConfig } from '@playwright/test';
import { withAccount } from './sessions.ts';

export default async function signOut(config: FullConfig): Promise<void> {
  await withAccount(config.projects[0]?.use.baseURL ?? '', () => Promise.resolve());
}
