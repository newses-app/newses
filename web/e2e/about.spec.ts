import { expect, test } from './axe.ts';
import { signIn } from './login.ts';

test.describe('about', () => {
  test('is public, with the AGPL notices, credits, and the app bundle licences', async ({
    page,
    context,
    expectNoViolations,
  }) => {
    await context.clearCookies();
    await page.goto('/login');
    await page.getByRole('link', { name: 'About Newses' }).click();
    await expect(page.getByRole('heading', { name: 'About Newses', level: 1 })).toBeVisible();
    await expect(page.getByText('It comes with absolutely no warranty.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Source code' })).toHaveAttribute(
      'href',
      /^https?:/,
    );
    // Signed out, only the app's packages are listed.
    await expect(page.getByText('Server', { exact: true })).toHaveCount(0);

    await page.getByText('Catppuccin').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Copyright (c) 2021 Catppuccin')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();

    await page.getByLabel('Filter by name or licence').fill('dexie');
    await page.getByText(/^dexie /).click();
    await expect(dialog.getByText('Apache License')).toBeVisible();
    await expect(dialog.getByText('David Fahlander').first()).toBeVisible();
    await expectNoViolations('about-licence');
    await dialog.getByRole('button', { name: 'Close' }).click();

    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test("lists the server's packages in Settings when signed in", async ({
    page,
    expectNoViolations,
  }) => {
    await signIn(page, '/settings/about');
    await expect(page.getByRole('tab', { name: 'About' })).toHaveAttribute('aria-selected', 'true');
    await page.getByText('Server', { exact: true }).click();
    await expect(page.getByText(/^\d+ packages?$/)).toBeVisible();
    await page.getByLabel('Filter by name or licence').fill('fastify');
    await expect(page.getByText(/^fastify \d/)).toBeVisible();
    await expectNoViolations('about');
  });
});
