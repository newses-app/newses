import type { Page } from '@playwright/test';
import { expect, test } from './axe.ts';
import { signIn } from './login.ts';

/** The built-in themes with a style beyond standard, with the bundled font its interface uses. */
const STYLES: { key: string; style: string; name: string; font?: string }[] = [
  { key: 'terminal', style: 'terminal', name: 'Terminal', font: 'IBM Plex Mono' },
  { key: 'amber', style: 'terminal', name: 'Amber monitor', font: 'IBM Plex Mono' },
  { key: 'sketch', style: 'sketch', name: 'Sketch', font: 'Patrick Hand' },
  { key: 'eink', style: 'eink', name: 'E-ink' },
  { key: 'synthwave', style: 'synthwave', name: 'Synthwave' },
  { key: 'noir', style: 'noir', name: 'Noir', font: 'Courier Prime' },
  { key: 'saul', style: 'saul', name: 'Saul', font: 'Oswald' },
];
/** The built-in themes that are a palette on the standard style. */
const PALETTES = [
  { key: 'catppuccin', name: 'Catppuccin' },
  { key: 'solarized', name: 'Solarized' },
  { key: 'gruvbox', name: 'Gruvbox' },
];

/** Back to Original without adjustments, deleting the themes these tests create. */
async function restoreAppearance(page: Page): Promise<void> {
  const session = await page.request.get('/api/v1/auth/session');
  const { csrfToken } = (await session.json()) as { csrfToken: string | null };
  const headers = { 'x-csrf-token': csrfToken ?? '' };
  await page.request.patch('/api/v1/prefs', {
    headers,
    data: { appearanceTheme: 'original', themeAdjustments: {} },
  });
  const themes = (await (await page.request.get('/api/v1/themes')).json()) as {
    id: number;
    name: string;
    mine: boolean;
  }[];
  for (const theme of themes.filter((t) => t.mine && t.name.startsWith('E2E ')))
    await page.request.delete(`/api/v1/themes/${String(theme.id)}`, { headers });
}

async function pickTheme(page: Page, name: string): Promise<void> {
  await page.goto('/settings/appearance');
  const reset = page.getByRole('button', { name: 'Reset adjustments' });
  if (await reset.isEnabled()) await reset.click();
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().endsWith('/api/v1/prefs'),
  );
  await page.getByRole('radio', { name, exact: true }).check();
  await saved;
}

for (const colorScheme of ['light', 'dark'] as const)
  test.describe(`themes (${colorScheme})`, () => {
    test.use({ colorScheme });

    test.beforeEach(async ({ page }) => {
      await signIn(page);
    });

    test.afterEach(async ({ page }) => {
      await restoreAppearance(page);
    });

    for (const style of STYLES)
      test(`shows the reader in the ${style.name} style`, async ({
        page,
        expectNoViolations,
      }, info) => {
        await pickTheme(page, style.name);
        await page.goto('/all');
        const root = page.locator('html');
        await expect(root).toHaveAttribute('data-theme-style', style.style);

        // The bundled font, served by the app itself.
        const family = style.font;
        if (family) {
          const font = await page
            .locator('.v-app-bar h1')
            .evaluate((h1) => getComputedStyle(h1).fontFamily);
          expect(font).toContain(family);
          await expect
            .poll(() => page.evaluate((f) => document.fonts.check(`16px "${f}"`), family))
            .toBe(true);
        }
        if (style.style === 'noir') {
          // The title jittered letter by letter, and whole for screen readers.
          const title = page.locator('.v-app-bar h1');
          await expect(title.locator('.d-sr-only')).toHaveText('All articles');
          await expect(title.locator('.jitter-letter').first()).not.toHaveCSS('transform', 'none');
          await expect(title).toHaveAccessibleName(/^All articles(\s+\d.*)?$/);
        }
        if (style.style === 'eink')
          await expect(page.locator('.v-app-bar .v-btn').first()).toHaveCSS(
            'transition-duration',
            '0s',
          );

        await page.getByRole('list', { name: 'Articles' }).getByRole('link').first().click();
        const selected = page.locator('.headline.selected');
        await expect(selected).toBeVisible();
        if (style.style === 'terminal' || style.style === 'eink') {
          // Inverse video: the text colour as background.
          const [background, text] = await page.evaluate(() => {
            const row = document.querySelector('.headline.selected');
            const app = document.querySelector('.v-application');
            const rgb = app ? getComputedStyle(app).getPropertyValue('--v-theme-on-surface') : '';
            return [
              row ? getComputedStyle(row).backgroundColor : '',
              `rgb(${rgb.split(',').join(', ')})`,
            ];
          });
          expect(background).toBe(text);
        } else if (style.style === 'synthwave') {
          // A neon edge fading from the primary colour.
          const [edge, primary] = await page.evaluate(() => {
            const row = document.querySelector('.headline.selected');
            const app = document.querySelector('.v-application');
            const rgb = app ? getComputedStyle(app).getPropertyValue('--v-theme-primary') : '';
            return [
              row ? getComputedStyle(row, '::before').backgroundImage : '',
              `rgb(${rgb.split(',').join(', ')})`,
            ];
          });
          expect(edge).toContain(primary);
        } else if (style.style === 'noir' || style.style === 'saul') {
          // Stamped in the primary colour (Noir), or cut out by a block of it (Saul).
          const [mark, primary] = await page.evaluate((saul) => {
            const row = document.querySelector('.headline.selected');
            const app = document.querySelector('.v-application');
            const rgb = app ? getComputedStyle(app).getPropertyValue('--v-theme-primary') : '';
            const before = row ? getComputedStyle(row, '::before') : null;
            return [
              (saul ? before?.backgroundColor : before?.borderTopColor) ?? '',
              `rgb(${rgb.split(',').join(', ')})`,
            ];
          }, style.style === 'saul');
          expect(mark).toBe(primary);
        } else {
          // A highlighter mark behind the title.
          await expect(selected.locator('.headline-title')).toHaveCSS(
            'background-image',
            /linear-gradient/,
          );
        }

        await expectNoViolations(`${style.key}-${colorScheme}-reader`);
        if (process.env.SCREENSHOTS)
          await page.screenshot({
            path: `${process.env.SCREENSHOTS}/${info.project.name}-${style.key}-${colorScheme}.png`,
          });
      });

    for (const palette of PALETTES)
      test(`shows the reader in ${palette.name}`, async ({ page, expectNoViolations }, info) => {
        await pickTheme(page, palette.name);
        await page.goto('/all');
        await expect(page.locator('html')).toHaveAttribute('data-theme-style', 'standard');
        await page.getByRole('list', { name: 'Articles' }).getByRole('link').first().click();
        await expect(page.locator('.headline.selected')).toBeVisible();

        await expectNoViolations(`${palette.key}-${colorScheme}-reader`);
        if (process.env.SCREENSHOTS)
          await page.screenshot({
            path: `${process.env.SCREENSHOTS}/${info.project.name}-${palette.key}-${colorScheme}.png`,
          });
      });
  });

test.describe('custom themes', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await restoreAppearance(page);
  });

  test.afterEach(async ({ page }) => {
    await restoreAppearance(page);
  });

  test('saves, updates, duplicates, exports, imports, and deletes themes', async ({ page }) => {
    const primary = () =>
      page.evaluate(() =>
        getComputedStyle(document.querySelector('.v-application') ?? document.body)
          .getPropertyValue('--v-theme-primary')
          .trim(),
      );
    const actionsFor = (name: string) =>
      page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
    const prefsSaved = () =>
      page.waitForResponse(
        (r) => r.request().method() === 'PATCH' && r.url().endsWith('/api/v1/prefs'),
      );
    await page.goto('/settings/appearance');

    // Adjust, then keep the adjustments as a theme of one's own, which becomes the one in use.
    let saved = prefsSaved();
    await page.getByLabel('Primary').fill('#0055aa');
    await saved;
    await page.getByRole('button', { name: 'Save as new theme' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('E2E Dusk');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('radio', { name: 'E2E Dusk', exact: true })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Reset adjustments' })).toBeDisabled();
    expect(await primary()).toBe('0,85,170');

    // Further adjustments update it in place.
    saved = prefsSaved();
    await page.getByLabel('Primary').fill('#aa0055');
    await saved;
    await page.getByRole('button', { name: 'Update theme' }).click();
    await expect(page.getByRole('button', { name: 'Reset adjustments' })).toBeDisabled();
    await expect.poll(primary).toBe('170,0,85');

    // Publishing shares it with everyone on the server, until it is unpublished.
    const dusk = page.locator('.theme-option').filter({ hasText: 'E2E Dusk' }).first();
    await actionsFor('E2E Dusk');
    await page.getByRole('menuitem', { name: 'Publish' }).click();
    await expect(dusk.getByText('Published', { exact: true })).toBeVisible();
    await actionsFor('E2E Dusk');
    await page.getByRole('menuitem', { name: 'Unpublish' }).click();
    await expect(dusk.getByText('Published', { exact: true })).toHaveCount(0);

    await actionsFor('E2E Dusk');
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(page.getByRole('radio', { name: 'E2E Dusk copy', exact: true })).toBeVisible();

    await actionsFor('E2E Dusk');
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Export' }).click();
    const file = await (await download).path();
    const { readFile } = await import('node:fs/promises');
    const exported = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(exported).toMatchObject({
      format: 'newses-theme',
      version: 1,
      name: 'E2E Dusk',
      base: 'original',
      tokens: { palette: { light: { primary: '#aa0055' } } },
    });

    // Importing it again takes a numbered name.
    await page.locator('input[type=file]').setInputFiles({
      name: 'dusk.newses-theme.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(exported)),
    });
    await expect(page.getByRole('radio', { name: 'E2E Dusk 2', exact: true })).toBeVisible();
    await page.locator('input[type=file]').setInputFiles({
      name: 'broken.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"format":"newses-theme","version":1}'),
    });
    await expect(page.getByText('That file is not a theme this server accepts.')).toBeVisible();

    // Deleting the theme in use returns to Original.
    await actionsFor('E2E Dusk');
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('radio', { name: 'Original', exact: true })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'E2E Dusk', exact: true })).toHaveCount(0);
  });
});
