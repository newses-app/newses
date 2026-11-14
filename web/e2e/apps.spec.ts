import { expect, test } from '@playwright/test';
import { credentials, signIn } from './login.ts';

test.describe('apps', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('connects TTRSS and Google Reader clients with the details settings show', async ({
    page,
    request,
  }) => {
    await page.goto('/settings/account');
    const detail = (key: string) =>
      page.locator(`[data-connection="${key}"] .connection-value`).innerText();
    const ttrssUrl = await detail('ttrss');
    const greaderUrl = await detail('greader');
    const freshrssUrl = await detail('freshrss');
    expect(await detail('login')).toBe(credentials.login);
    expect(ttrssUrl).toBe(`${greaderUrl}/`);
    expect(freshrssUrl).toBe(`${greaderUrl}/api/greader.php`);
    await expect(page.getByText(/sync no more often than every \d+ minutes/)).toBeVisible();

    const name = `e2e ${String(Date.now())}`;
    await page.getByRole('button', { name: 'New app password' }).click();
    const dialog = page.getByRole('dialog');
    // Focus moves to the name once the dialog has opened; typing before that can land in it.
    await expect(dialog.getByLabel('Name')).toBeFocused();
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByLabel('Current password').fill(credentials.password);
    await dialog.getByRole('button', { name: 'New app password' }).click();
    const password = await dialog.locator('code').innerText();
    await dialog.getByRole('button', { name: 'Close' }).click();

    // Settings show the server's public address (PUBLIC_URL), which a proxy in front of the tested
    // deployment may serve, so the clients' requests go to the same paths on the deployment itself.
    try {
      const ttrss = await request.post('/api/', {
        data: { op: 'login', user: credentials.login, password },
      });
      expect(await ttrss.json()).toMatchObject({ status: 0, content: { api_level: 20 } });

      const login = await request.post('/accounts/ClientLogin', {
        form: { Email: credentials.login, Passwd: password },
      });
      expect(login.status()).toBe(200);
      const auth = /^Auth=(.+)$/m.exec(await login.text())?.[1] ?? '';
      for (const base of ['', '/api/greader.php']) {
        const list = await request.get(`${base}/reader/api/0/subscription/list?output=json`, {
          headers: { authorization: `GoogleLogin auth=${auth}` },
        });
        expect(list.status()).toBe(200);
        expect(await list.json()).toHaveProperty('subscriptions');
      }
    } finally {
      await page.getByRole('button', { name: `Revoke ${name}` }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
      await expect(page.getByText(name)).toHaveCount(0);
    }
  });
});
