import { expect, type Page, test } from '@playwright/test';
import { signIn } from './login.ts';

/** Opens every feed's archive; skips the test when the deployment has no past articles. */
async function openArchive(page: Page) {
  await page.goto('/all');
  await page.getByRole('button', { name: 'Browse archive' }).click();
  await expect(page).toHaveURL(/\/all\/archive$/);
  const list = page.getByRole('list', { name: 'Past articles' });
  await expect(list.or(page.getByText('No past articles.'))).toBeVisible();
  test.skip(!(await list.isVisible()), 'The deployment has no past articles');
  return list;
}

test.describe('archive', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('searches past articles', async ({ page }) => {
    const list = await openArchive(page);
    const title = (await list.getByRole('link').first().locator('.v-list-item-title').innerText())
      .split(/\W+/)
      .find((word) => word.length >= 4);
    test.skip(!title, 'The first past article has no searchable title');
    await page.getByLabel('Search the archive').fill(title ?? '');
    await page.getByLabel('Search the archive').press('Enter');
    await expect(page).toHaveURL(/\/all\/archive\?q=/);
    await expect(list.getByRole('link').first()).toBeVisible();
  });

  test('brings a past article back to its feed by starring it', async ({ page }) => {
    const list = await openArchive(page);
    await list.getByRole('link').first().click();
    await expect(page).toHaveURL(/\/all\/archive\/[\w.-]+$/);
    const article = page.locator('article');
    await expect(article.getByText(/A past article/)).toBeVisible();
    await article.getByRole('button', { name: 'Star', exact: true }).click();
    // The restored article opens in its feed.
    await expect(page).toHaveURL(/\/f\d+\/\d+$/);
    const restored = page.locator('article');
    await expect(restored.getByRole('button', { name: 'Unstar' })).toBeVisible();
    await restored.getByRole('button', { name: 'Unstar' }).click();
    await expect(restored.getByRole('button', { name: 'Star', exact: true })).toBeVisible();
  });
});
