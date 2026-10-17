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

  test('reads, stars, notes, and catches up offline, and the server has it all after', async ({
    page,
    context,
  }) => {
    await signIn(page);
    await page.evaluate(() => {
      localStorage.setItem('newses.offline.enabled', 'true');
    });
    await page.goto('/all');
    await page.waitForFunction(readyOffline, false, { timeout: 60_000 });
    const api = async <T>(path: string) =>
      (await (await page.request.get(`/api/v1${path}`)).json()) as T;
    interface Counters {
      subscriptions: { id: number; unread: number }[];
    }
    interface Entry {
      id: number;
      starred: boolean;
      note: string | null;
    }
    // A feed with a few unread articles, so catching it up is quick to undo.
    const feed = (await api<Counters>('/counters')).subscriptions
      .filter((s) => s.unread > 1)
      .sort((a, b) => a.unread - b.unread)[0];
    test.skip(!feed, 'Needs a feed with two or more unread articles');
    if (!feed) return;
    const unread = (
      await api<{ entries: Entry[] }>(
        `/entries?subscriptionId=${String(feed.id)}&view=unread&limit=200`,
      )
    ).entries;
    await page.goto(`/f${String(feed.id)}`);
    const first = page.getByRole('list', { name: 'Articles' }).getByRole('link').first();
    await expect(first).toBeVisible();

    await context.setOffline(true);
    await first.click();
    const id = Number(/\/(\d+)$/.exec(page.url())?.[1]);
    const before = unread.find((e) => e.id === id);
    const article = page.locator('article');
    await expect(article.getByRole('heading').first()).toBeVisible();
    // Stored images show from the device; the others have no source offline.
    const sources = await article
      .locator('.article-content img[src]')
      .evaluateAll((images) => images.map((image) => image.getAttribute('src') ?? ''));
    for (const src of sources) expect(src).toMatch(/^blob:/);
    if (!before?.starred) await article.getByRole('button', { name: 'Star', exact: true }).click();
    await article.getByRole('button', { name: /^(Add|Edit) note$/ }).click();
    await page.getByRole('dialog').getByLabel('Note').fill('e2e offline note');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Mark as read', exact: true }).click();
    await page.getByRole('menuitem', { name: 'All articles' }).click();
    // Asked first only when the reader's preference says so.
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Mark read' })
      .click({ timeout: 3000 })
      .catch(() => undefined);
    await expect(page.getByText(/couldn't|went wrong/)).toHaveCount(0);

    await context.setOffline(false);
    await expect
      .poll(
        async () => {
          const entry = await api<Entry>(`/entries/${String(id)}`);
          return [entry.starred, entry.note];
        },
        { timeout: 30_000 },
      )
      .toEqual([true, 'e2e offline note']);
    await expect
      .poll(
        async () =>
          (await api<Counters>('/counters')).subscriptions.find((s) => s.id === feed.id)?.unread,
        { timeout: 30_000 },
      )
      .toBe(0);

    // As it was.
    const { csrfToken } = await api<{ csrfToken: string }>('/auth/session');
    const headers = { 'x-csrf-token': csrfToken };
    await page.request.patch('/api/v1/entries', {
      headers,
      data: { ids: unread.map((e) => e.id), unread: true },
    });
    await page.request.patch(`/api/v1/entries/${String(id)}`, {
      headers,
      data: { starred: before?.starred ?? false },
    });
    await page.request.put(`/api/v1/entries/${String(id)}/note`, {
      headers,
      data: { note: before?.note ?? null },
    });
    await page.evaluate(() => {
      localStorage.removeItem('newses.offline.enabled');
    });
  });
});
