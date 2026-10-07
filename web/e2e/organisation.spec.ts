import { expect, test } from '@playwright/test';
import { signIn } from './login.ts';

test.describe('organisation', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('adds, shows, and removes a note', async ({ page }) => {
    const note = `e2e note ${String(Date.now())}`;
    await page.goto('/all');
    await page.getByRole('list', { name: 'Articles' }).getByRole('link').first().click();
    const article = page.locator('article');
    await article.getByRole('button', { name: 'Add note' }).click();
    await page.getByRole('dialog').getByLabel('Note').fill(note);
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(article.getByText(note)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Articles' }).getByText(note)).toBeVisible();

    await article.getByRole('button', { name: 'Edit note' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove note' }).click();
    await expect(article.getByText(note)).toBeHidden();
    await expect(article.getByRole('button', { name: 'Add note' })).toBeVisible();
  });

  test('creates a label, assigns it, and opens its stream', async ({ page }) => {
    const caption = `e2e-${String(Date.now())}`;
    await page.goto('/all');
    await page.getByRole('list', { name: 'Articles' }).getByRole('link').first().click();
    const article = page.locator('article');
    await article.getByRole('button', { name: 'Labels', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('New label').fill(caption);
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(dialog.getByRole('checkbox', { name: caption })).toBeChecked();
    await dialog.getByRole('button', { name: 'Save' }).click();

    await article.getByRole('link', { name: caption }).click();
    await expect(page).toHaveURL(/\/l\d+$/);
    await expect(
      page.getByRole('list', { name: 'Feeds' }).getByRole('link', { name: caption }),
    ).toBeVisible();
    await expect(page.getByRole('list', { name: 'Articles' }).getByRole('link')).toHaveCount(1);

    await page.goto('/settings/labels');
    await page.getByRole('button', { name: `Delete label ${caption}` }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText(caption)).toHaveCount(0);
  });

  test('tags an article and browses by tag', async ({ page }) => {
    const tag = `e2e tag ${String(Date.now())}`;
    await page.goto('/all');
    await page.getByRole('list', { name: 'Articles' }).getByRole('link').first().click();
    const article = page.locator('article');
    await article.getByRole('button', { name: 'Tags', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Tags').fill(`${tag.toUpperCase()},`);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole('list', { name: 'Feeds' }).getByRole('button', { name: 'Tags' }).click();
    await dialog.getByLabel('Find a tag').fill(tag);
    await page.getByRole('option', { name: tag }).click();
    await expect(page).toHaveURL(new RegExp(`/t${encodeURIComponent(tag)}$`));
    await expect(page.getByRole('heading', { name: `Tag: ${tag}` })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Articles' }).getByRole('link')).toHaveCount(1);

    await page.getByRole('list', { name: 'Articles' }).getByRole('link').first().click();
    await article.getByRole('button', { name: 'Tags', exact: true }).click();
    await dialog.getByRole('button', { name: 'Close' }).first().click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(article.getByRole('link', { name: tag })).toBeHidden();
  });
});
