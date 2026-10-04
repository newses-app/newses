import { expect, type Page } from '@playwright/test';

export const credentials = {
  login: process.env.E2E_LOGIN ?? 'admin',
  password: process.env.E2E_PASSWORD ?? 'admin-e2e-password',
};

export async function signIn(page: Page, path = '/all'): Promise<void> {
  await page.goto(path);
  await page.getByLabel('User name').fill(credentials.login);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('list', { name: 'Feeds' })).toBeVisible();
}
