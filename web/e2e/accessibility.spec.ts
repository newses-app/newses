import { signIn } from './login.ts';
import { expect, test } from './axe.ts';

/** Dialogs and menus only: the reader and settings scans cover the page behind them. */
const overlay = { include: '.v-overlay-container' };

// The theme preference follows the system by default, so the colour scheme selects the theme.
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`accessibility (${colorScheme})`, () => {
    test.use({ colorScheme });

    test.describe('desktop', () => {
      test.beforeEach(({ browserName, isMobile }) => {
        test.skip(browserName !== 'chromium' || isMobile, 'desktop scans run on Chromium');
      });

      test('login', async ({ page, context, expectNoViolations }) => {
        await context.clearCookies();
        await page.goto('/login');
        await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
        await expectNoViolations('login');
      });

      test('reader', async ({ page, expectNoViolations }) => {
        await signIn(page);
        const headlines = page.getByRole('list', { name: 'Articles' });
        await expect(headlines.getByRole('link').first()).toBeVisible();
        await expectNoViolations('three-panes');

        await headlines.getByRole('link').first().click();
        await expect(page.locator('article').getByRole('heading').first()).toBeVisible();
        await expectNoViolations('article');

        await page.getByRole('button', { name: 'Combined (expanded articles)' }).click();
        await expect(page.locator('.combined-card').first()).toBeVisible();
        try {
          await expectNoViolations('combined');
        } finally {
          await page.getByRole('button', { name: 'Three panes' }).click();
        }
      });

      test('settings', async ({ page, expectNoViolations }) => {
        await signIn(page);
        for (const tab of [
          'preferences',
          'appearance',
          'shortcuts',
          'feeds',
          'labels',
          'filters',
          'sharing',
          'offline',
          'account',
          'users',
        ]) {
          await page.goto(`/settings/${tab}`);
          await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
          await expectNoViolations(`settings-${tab}`);
        }
      });

      test('dialogs', async ({ page, expectNoViolations }) => {
        await signIn(page);
        const dialog = page.getByRole('dialog');

        await page.locator('body').press('?');
        await expect(dialog.getByText('Keyboard shortcuts')).toBeVisible();
        await expectNoViolations('shortcut-help', overlay);
        await dialog.getByRole('button', { name: 'Close' }).click();
        await expect(dialog).toBeHidden();

        await page.getByRole('button', { name: 'Subscribe' }).click();
        await expect(dialog.getByLabel('Feed or website address')).toBeVisible();
        await expectNoViolations('subscribe', overlay);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();

        await page.getByRole('button', { name: 'Mark as read' }).click();
        await expect(page.getByRole('menu')).toBeVisible();
        await expectNoViolations('catch-up-menu', overlay);
        await page.getByRole('menuitem', { name: 'All articles' }).click();
        await expect(dialog.getByRole('button', { name: 'Mark read' })).toBeVisible();
        await expectNoViolations('confirm', overlay);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();

        await page.getByRole('list', { name: 'Articles' }).getByRole('link').first().click();
        await page.locator('article').getByRole('button', { name: /note$/ }).click();
        await expect(dialog.getByLabel('Note')).toBeVisible();
        await expectNoViolations('note', overlay);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
        await page.locator('article').getByRole('button', { name: 'Labels', exact: true }).click();
        await expect(dialog.getByLabel('New label')).toBeVisible();
        await expectNoViolations('entry-labels', overlay);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
        await page.locator('article').getByRole('button', { name: 'Tags', exact: true }).click();
        await expect(dialog.getByLabel('Tags')).toBeVisible();
        await expectNoViolations('entry-tags', overlay);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
        await page
          .locator('article')
          .getByRole('button', { name: /^Share/ })
          .click();
        await expect(dialog.getByText('Share link')).toBeVisible();
        await expectNoViolations('share', overlay);
        await dialog.getByRole('button', { name: 'Close' }).click();
        await expect(dialog).toBeHidden();
        await page
          .getByRole('list', { name: 'Feeds' })
          .getByRole('button', { name: 'Tags' })
          .click();
        await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();
        await expectNoViolations('tag-picker', overlay);
        await dialog.getByRole('button', { name: 'Close' }).click();
        await expect(dialog).toBeHidden();
      });

      test('settings dialogs', async ({ page, expectNoViolations }) => {
        await signIn(page);
        const dialog = page.getByRole('dialog');

        await page.goto('/settings/feeds');
        await page.getByRole('table').getByRole('button', { name: /^Edit/ }).first().click();
        await expect(dialog.getByLabel('Title')).toBeVisible();
        await expectNoViolations('edit-feed', overlay);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();

        await page.goto('/settings/shortcuts');
        await page.getByRole('button', { name: 'Add keys for Show this help' }).click();
        await dialog.getByRole('textbox', { name: 'Keys' }).press('s');
        await expect(dialog.getByRole('button', { name: 'Replace' })).toBeVisible();
        await expectNoViolations('record-shortcut', overlay);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();

        await page.goto('/settings/labels');
        await page.getByRole('button', { name: 'New label' }).click();
        await expect(dialog.getByLabel('Name')).toBeVisible();
        await expectNoViolations('edit-label', overlay);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();

        await page.goto('/settings/filters');
        await page.getByRole('button', { name: 'New filter' }).click();
        await expect(dialog.getByLabel('Pattern')).toBeVisible();
        await expectNoViolations('edit-filter', overlay);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
      });
    });

    test('phone layout @mobile', async ({ page, isMobile, expectNoViolations }) => {
      test.skip(!isMobile, 'phone layout');
      await signIn(page);
      const headlines = page.getByRole('list', { name: 'Articles' });
      await expect(headlines.getByRole('link').first()).toBeVisible();
      await expectNoViolations('phone-list');

      await headlines.getByRole('link').first().click();
      await expect(page.locator('article')).toBeVisible();
      await expectNoViolations('phone-article');

      await page.getByRole('button', { name: 'Back to list' }).click();
      await page.getByRole('button', { name: 'Feeds' }).click();
      await expect(page.getByRole('list', { name: 'Feeds' })).toBeVisible();
      // The modal drawer's scrim covers the page behind it, which axe would measure as obscured
      // targets; only the drawer is operable.
      await expectNoViolations('phone-drawer', { include: '.v-navigation-drawer' });
    });
  });
}
