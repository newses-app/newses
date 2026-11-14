import type { Prefs } from '@newses/shared';
import { DEFAULT_PREFS } from '@newses/shared/client';
import { expect, type Page } from '@playwright/test';

export const credentials = {
  login: process.env.E2E_LOGIN ?? 'admin',
  password: process.env.E2E_PASSWORD ?? 'admin-e2e-password',
};

/** The preferences the tests change, each test starting from its default. */
const TESTED_PREFS = [
  'layout',
  'appearanceTheme',
  'themeAdjustments',
  'articleFont',
  'articleFontSize',
  'articleWidth',
  'shortcutBindings',
] as const satisfies readonly (keyof Prefs)[];

/**
 * Puts back the preferences the tests change, which a run stopped mid-test, or the account's
 * reader, may have left otherwise; the tests read the three-pane layout's headline list.
 */
async function resetTestedPrefs(page: Page): Promise<void> {
  const prefs = (await (await page.request.get('/api/v1/prefs')).json()) as Prefs;
  const changed = Object.fromEntries(
    TESTED_PREFS.filter(
      (key) => JSON.stringify(prefs[key]) !== JSON.stringify(DEFAULT_PREFS[key]),
    ).map((key) => [key, DEFAULT_PREFS[key]]),
  );
  if (Object.keys(changed).length === 0) return;
  const session = await page.request.get('/api/v1/auth/session');
  const { csrfToken } = (await session.json()) as { csrfToken: string | null };
  await page.request.patch('/api/v1/prefs', {
    headers: { 'x-csrf-token': csrfToken ?? '' },
    data: changed,
  });
  await page.reload();
}

export async function signIn(page: Page, path = '/all'): Promise<void> {
  await page.goto(path);
  await page.getByLabel('User name').fill(credentials.login);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('list', { name: 'Feeds' })).toBeVisible();
  await resetTestedPrefs(page);
  await expect(page.getByRole('list', { name: 'Feeds' })).toBeVisible();
}
