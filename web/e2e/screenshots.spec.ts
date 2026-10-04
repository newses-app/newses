import { test } from '@playwright/test';
import { signIn } from './login.ts';

// Not assertions: captures the main screens for review when SCREENSHOTS is set.
test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=dir to capture');

test('capture main screens @mobile', async ({ page }, info) => {
  const dir = process.env.SCREENSHOTS ?? '';
  const shot = (name: string) =>
    page.screenshot({ path: `${dir}/${info.project.name}-${name}.png` });
  await page.goto('/login');
  await shot('login');
  await signIn(page);
  await page.waitForTimeout(500);
  await shot('all');
  await page.getByRole('list', { name: 'Articles' }).getByRole('link').nth(1).click();
  await page.waitForTimeout(800);
  await shot('article');
  await page.goto('/settings/feeds');
  await page.waitForTimeout(500);
  await shot('settings-feeds');
  await page.goto('/settings/preferences');
  await page.waitForTimeout(500);
  await shot('settings-preferences');
  await page.goto('/c2');
  await page
    .getByRole('button', { name: /Combined|Three panes/ })
    .first()
    .isVisible();
  await page.keyboard.press('f');
  await page.keyboard.press('C');
  await page.waitForTimeout(800);
  await shot('combined');
  await page.keyboard.press('f');
  await page.keyboard.press('C');
  await page.keyboard.press('?');
  await page.waitForTimeout(500);
  await shot('help');
  await page.keyboard.press('Escape');
  await page.keyboard.press('f');
  await page.keyboard.press('s');
  await page.waitForTimeout(500);
  await shot('subscribe');
});
