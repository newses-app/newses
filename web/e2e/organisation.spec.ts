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

  test('scores an article, highlighting it, then hiding it from the feed lists', async ({
    page,
  }) => {
    await page.goto('/all');
    const list = page.getByRole('list', { name: 'Articles' });
    await list.getByRole('link').first().click();
    const url = page.url();
    const article = page.locator('article');
    // Titles repeat in some feeds, so the row is found by entry id.
    const row = list.locator(`[data-entry="${url.split('/').pop() ?? ''}"]`);
    const dialog = page.getByRole('dialog');

    await article.getByRole('button', { name: 'Set score' }).click();
    await dialog.getByLabel('Score').fill('120');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(article.getByRole('button', { name: 'Score 120' })).toBeVisible();
    await expect(row).toContainText('High score');

    await article.getByRole('button', { name: 'Score 120' }).click();
    await dialog.getByLabel('Score').fill('-600');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await page.goto(url);
    await expect(article.getByRole('button', { name: /^Score / })).toBeVisible();
    await expect(list.getByRole('link').first()).toBeVisible();
    await expect(row).toHaveCount(0);

    await article.getByRole('button', { name: /^Score / }).click();
    await dialog.getByRole('button', { name: 'Reset to 0' }).click();
    await expect(article.getByRole('button', { name: 'Set score' })).toBeVisible();
    await page.reload();
    await expect(row).toBeVisible();
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

  test('creates a filter, tests it, applies it, and deletes it', async ({ page }) => {
    const title = `e2e filter ${String(Date.now())}`;
    await page.goto('/all');
    const first = page.getByRole('list', { name: 'Articles' }).getByRole('link').first();
    const articleTitle = (await first.locator('.headline-title').innerText()).trim();
    const word = articleTitle.split(/\s+/).find((w) => /^[A-Za-z]{4,}$/.test(w)) ?? articleTitle;

    await page.goto('/settings/filters');
    await page.getByRole('button', { name: 'New filter' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(title);
    await dialog.getByLabel('Pattern').fill(word);
    // Vuetify's field wrapper receives the click for its inner input.
    await dialog.locator('fieldset[aria-label="Action 1"] .v-select').click();
    await page.getByRole('option', { name: 'Change score' }).click();
    await dialog.getByLabel('Score change').fill('0');
    await dialog.getByRole('button', { name: 'Test' }).click();
    await expect(dialog.getByText(/of your \d+ most recent articles match/)).toBeVisible();
    await expect(
      dialog.getByRole('list', { name: 'Test results' }).getByRole('listitem').first(),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();

    const row = page.locator(`[data-filter="${title}"]`);
    await expect(row).toBeVisible();
    await page.getByRole('button', { name: `Apply ${title} to existing articles` }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Apply to existing articles' })
      .click();
    await expect(page.getByText(/Checked \d+ articles; [1-9]\d* matched/)).toBeVisible();

    await page.getByRole('button', { name: `Delete filter ${title}` }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(row).toHaveCount(0);
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

  test('shares an article publicly and revokes the link', async ({ page, browser }) => {
    await page.goto('/all');
    await page.getByRole('list', { name: 'Articles' }).getByRole('link').first().click();
    const article = page.locator('article');
    const title = (await article.getByRole('heading').first().textContent())?.trim() ?? '';
    await article.getByRole('button', { name: /^Shared?$/ }).click();
    const dialog = page.getByRole('dialog');
    // A link left over from an earlier run is revoked first.
    const stop = dialog.getByRole('button', { name: 'Stop sharing' });
    if (await stop.isVisible()) await stop.click();
    await dialog.getByRole('button', { name: 'Create link' }).click();
    const url = await dialog.getByRole('textbox', { name: 'Public link' }).inputValue();
    expect(url).toMatch(/\/public\/share\/[0-9a-f-]{36}$/);

    // The owner's browser runs the app's service worker, which must leave public pages to the server.
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    const ownTab = await page.context().newPage();
    await ownTab.goto(url);
    await expect(ownTab.getByRole('heading', { level: 1 })).toHaveText(title);
    expect(ownTab.url()).toBe(url);
    await ownTab.close();

    const visitor = await browser.newContext();
    const publicPage = await visitor.newPage();
    const response = await publicPage.goto(url);
    expect(response?.status()).toBe(200);
    await expect(publicPage.getByRole('heading', { level: 1 })).toHaveText(title);

    await dialog.getByRole('button', { name: 'Stop sharing' }).click();
    await expect(dialog.getByRole('button', { name: 'Create link' })).toBeVisible();
    expect((await publicPage.goto(url))?.status()).toBe(404);
    await visitor.close();
  });

  test('serves the published feed at its address', async ({ page, request }) => {
    await page.goto('/settings/sharing');
    const address = await page.getByRole('textbox', { name: 'Feed address' }).inputValue();
    expect(address).toMatch(/\/public\/feeds\/[\w-]{43}$/);
    const feed = await request.get(address);
    expect(feed.status()).toBe(200);
    expect(feed.headers()['content-type']).toContain('application/rss+xml');
    expect(await feed.text()).toContain('<title>Published articles</title>');
  });
});
