import { expect, test } from '@playwright/test';
import { signIn } from './login.ts';

test.describe('reader', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('redirects to sign-in and back', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/starred');
    await expect(page).toHaveURL(/\/login\?redirect=(%2F|\/)starred$/);
    await signIn(page, page.url());
    await expect(page).toHaveURL(/\/starred$/);
  });

  test('opens an article, marks it read, and stars it', async ({ page }) => {
    await page.goto('/all');
    const headlines = page.getByRole('list', { name: 'Articles' });
    const first = headlines.getByRole('link').first();
    await first.click();
    await expect(page).toHaveURL(/\/all\/\d+$/);
    const article = page.locator('article');
    await expect(article.getByRole('heading').first()).toBeVisible();
    await expect(article.getByRole('button', { name: 'Mark unread' })).toBeVisible();
    await article.getByRole('button', { name: 'Star', exact: true }).click();
    await expect(article.getByRole('button', { name: 'Unstar' })).toBeVisible();
    await page.goto('/starred');
    await expect(page.getByRole('list', { name: 'Articles' }).getByRole('link')).toHaveCount(1);
    await page.getByRole('list', { name: 'Articles' }).getByRole('link').first().click();
    await page.locator('article').getByRole('button', { name: 'Unstar' }).click();
    await expect(
      page.locator('article').getByRole('button', { name: 'Star', exact: true }),
    ).toBeVisible();
  });

  test('navigates with keyboard shortcuts', async ({ page }) => {
    await page.goto('/all');
    await expect(
      page.getByRole('list', { name: 'Articles' }).getByRole('link').first(),
    ).toBeVisible();
    await page.locator('body').press('n');
    await expect(page).toHaveURL(/\/all\/(\d+)$/);
    const firstUrl = page.url();
    await page.locator('body').press('n');
    await expect(page).not.toHaveURL(firstUrl);
    await page.locator('body').press('p');
    await expect(page).toHaveURL(firstUrl);
    await page.locator('body').press('j');
    await expect(page).toHaveURL(/\/fresh$/);
    await page.locator('body').press('g');
    await page.locator('body').press('s');
    await expect(page).toHaveURL(/\/starred$/);
    await page.locator('body').press('?');
    await expect(page.getByRole('dialog').getByText('Keyboard shortcuts')).toBeVisible();
    await page.keyboard.press('Escape');
    // The dialog hands focus back when its transition ends.
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.locator('body').press('/');
    await expect(page.getByLabel('Search articles')).toBeFocused();
  });

  test('updates unread counts live when another device changes state', async ({ page }) => {
    await page.goto('/all');
    const all = page
      .getByRole('list', { name: 'Feeds' })
      .getByRole('link', { name: /All articles/ });
    const count = async () => Number((await all.innerText()).match(/\d+/)?.[0] ?? 0);
    await expect(
      page.getByRole('list', { name: 'Articles' }).getByRole('link').first(),
    ).toBeVisible();
    // Another device: the same session through the API, outside the app.
    const { csrfToken } = (await (await page.request.get('/api/v1/auth/session')).json()) as {
      csrfToken: string;
    };
    const { entries } = (await (await page.request.get('/api/v1/entries?limit=1')).json()) as {
      entries: { id: number; unread: boolean }[];
    };
    const entry = entries[0];
    if (!entry) throw new Error('no entries');
    const before = await count();
    const target = !entry.unread;
    await page.request.patch(`/api/v1/entries/${String(entry.id)}`, {
      headers: { 'x-csrf-token': csrfToken },
      data: { unread: target },
    });
    await expect.poll(count, { timeout: 5000 }).toBe(before + (target ? 1 : -1));
    await page.request.patch(`/api/v1/entries/${String(entry.id)}`, {
      headers: { 'x-csrf-token': csrfToken },
      data: { unread: entry.unread },
    });
  });

  test('searches within the open stream', async ({ page }) => {
    await page.goto('/all');
    const title = await page
      .getByRole('list', { name: 'Articles' })
      .getByRole('link')
      .first()
      .locator('.v-list-item-title')
      .innerText();
    const word = title.split(/\s+/).find((w) => w.length > 4) ?? title;
    await page.getByLabel('Search articles').fill(word);
    await page.getByLabel('Search articles').press('Enter');
    await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(word)}`));
    await expect(
      page.getByRole('list', { name: 'Articles' }).getByRole('link').first(),
    ).toBeVisible();
  });

  test('switches to the combined layout and back', async ({ page }) => {
    await page.goto('/all');
    await page.getByRole('button', { name: 'Combined (expanded articles)' }).click();
    await expect(page.locator('.combined-card').first()).toBeVisible();
    await page.getByRole('button', { name: 'Three panes' }).click();
    await expect(page.getByRole('list', { name: 'Articles' })).toBeVisible();
  });

  test('changes the theme from settings', async ({ page }) => {
    await page.goto('/settings');
    // Vuetify's field wrapper receives the click for its inner input.
    const theme = page.locator('.v-select').filter({ hasText: 'Theme' });
    await theme.click();
    await page.getByRole('option', { name: 'Dark' }).click();
    await expect(page.locator('.v-theme--dark').first()).toBeVisible();
    await theme.click();
    await page.getByRole('option', { name: 'Follow system' }).click();
    await expect(page.locator('.v-theme--light').first()).toBeVisible();
  });

  test('shows one pane at a time on phones @mobile', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'phone layout');
    await page.goto('/all');
    await page.getByRole('list', { name: 'Articles' }).getByRole('link').first().click();
    await expect(page.locator('article')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Articles' })).toBeHidden();
    await page.getByRole('button', { name: 'Back to list' }).click();
    await expect(page.getByRole('list', { name: 'Articles' })).toBeVisible();
  });
});
