import { expect, type Page } from '@playwright/test';

export const credentials = {
  login: process.env.E2E_LOGIN ?? 'admin',
  password: process.env.E2E_PASSWORD ?? 'admin-e2e-password',
};

/**
 * The tests read the three-pane layout's headline list; the account may have been left in the
 * combined layout, by its reader or by a run stopped while a test had switched it.
 */
async function useThreePanes(page: Page): Promise<void> {
  const prefs = (await (await page.request.get('/api/v1/prefs')).json()) as { layout: string };
  if (prefs.layout === 'threePane') return;
  const session = await page.request.get('/api/v1/auth/session');
  const { csrfToken } = (await session.json()) as { csrfToken: string | null };
  await page.request.patch('/api/v1/prefs', {
    headers: { 'x-csrf-token': csrfToken ?? '' },
    data: { layout: 'threePane' },
  });
  await page.reload();
}

export async function signIn(page: Page, path = '/all'): Promise<void> {
  await page.goto(path);
  await page.getByLabel('User name').fill(credentials.login);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('list', { name: 'Feeds' })).toBeVisible();
  await useThreePanes(page);
  await expect(page.getByRole('list', { name: 'Feeds' })).toBeVisible();
}
