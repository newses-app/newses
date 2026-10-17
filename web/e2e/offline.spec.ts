import { expect, test } from '@playwright/test';
import { signIn } from './login.ts';

/** Whether the service worker controls the page and the first sync has filled the store. */
async function readyOffline(): Promise<boolean> {
  if (!navigator.serviceWorker.controller) return false;
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
    await page.waitForFunction(readyOffline, undefined, { timeout: 60_000 });

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('list', { name: 'Feeds' })).toBeVisible();
    await expect(page.getByText(/reach the server/)).toHaveCount(0);

    await context.setOffline(false);
    await page.evaluate(() => {
      localStorage.removeItem('newses.offline.enabled');
    });
  });
});
