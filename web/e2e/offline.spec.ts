import { expect, test } from '@playwright/test';
import { signIn } from './login.ts';

/** Whether the first sync has filled the store, and with `worker` the service worker controls the page. */
async function readyOffline(worker: boolean): Promise<boolean> {
  if (worker && !navigator.serviceWorker.controller) return false;
  const account = JSON.parse(localStorage.getItem('newses.offline.account') ?? 'null') as {
    name: string;
  } | null;
  if (!account) return false;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(account.name);
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB'));
    };
  });
  try {
    if (!db.objectStoreNames.contains('meta')) return false;
    const token = await new Promise<unknown>((resolve) => {
      const get = db.transaction('meta').objectStore('meta').get('syncToken');
      get.onsuccess = () => {
        resolve(get.result);
      };
    });
    return token !== undefined;
  } finally {
    db.close();
  }
}

test.describe('offline', () => {
  test('starts from the stored snapshot without a connection', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'Playwright runs service workers in Chromium only');
    await signIn(page);
    await page.evaluate(() => {
      localStorage.setItem('newses.offline.enabled', 'true');
    });
    await page.reload();
    await expect(page.getByRole('list', { name: 'Feeds' })).toBeVisible();
    await page.waitForFunction(readyOffline, true, { timeout: 60_000 });

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('list', { name: 'Feeds' })).toBeVisible();
    await expect(page.getByText(/reach the server/)).toHaveCount(0);

    await context.setOffline(false);
    await page.evaluate(() => {
      localStorage.removeItem('newses.offline.enabled');
    });
  });

  test('keeps a change made offline and sends it on reconnecting', async ({ page, context }) => {
    await signIn(page);
    await page.evaluate(() => {
      localStorage.setItem('newses.offline.enabled', 'true');
    });
    await page.goto('/all');
    await page.waitForFunction(readyOffline, false, { timeout: 60_000 });
    await page.getByRole('list', { name: 'Articles' }).getByRole('link').first().click();
    await expect(page).toHaveURL(/\/all\/\d+$/);
    const id = /\/(\d+)$/.exec(page.url())?.[1] ?? '';
    const article = page.locator('article');
    await expect(article.getByRole('button', { name: 'Mark unread' })).toBeVisible();
    const starred = async () =>
      ((await (await page.request.get(`/api/v1/entries/${id}`)).json()) as { starred: boolean })
        .starred;

    await context.setOffline(true);
    await article.getByRole('button', { name: 'Star', exact: true }).click();
    await expect(article.getByRole('button', { name: 'Unstar' })).toBeVisible();
    await expect(page.getByText(/couldn't|went wrong/)).toHaveCount(0);

    await context.setOffline(false);
    await expect.poll(starred, { timeout: 30_000 }).toBe(true);
    await article.getByRole('button', { name: 'Unstar' }).click();
    await expect.poll(starred).toBe(false);
    await page.evaluate(() => {
      localStorage.removeItem('newses.offline.enabled');
    });
  });
});
