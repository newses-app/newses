import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page } from '@playwright/test';

export { expect };

/** WCAG 2.2 AA, as the Accessibility non-functional requirement states. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export const test = base.extend<{
  /** Scans the page once transitions settle, attaches the results, and expects no violations. */
  expectNoViolations: (name: string, options?: { include?: string }) => Promise<void>;
}>({
  expectNoViolations: async ({ page }, use, testInfo) => {
    await use(async (name, options = {}) => {
      await settle(page);
      const builder = new AxeBuilder({ page })
        .withTags(TAGS)
        // Sanitised third-party feed HTML: its markup is the publisher's, not the app's.
        .exclude('.article-content');
      if (options.include) builder.include(options.include);
      const results = await builder.analyze();
      await testInfo.attach(`axe-${name}`, {
        body: JSON.stringify(results, null, 2),
        contentType: 'application/json',
      });
      const summary = results.violations.map((v) => ({
        rule: v.id,
        help: v.help,
        targets: v.nodes.map((n) => n.target.join(' ')),
      }));
      expect.soft(summary, `axe violations on ${name}`).toEqual([]);
    });
  },
});

/** Waits for finite animations (dialog and menu transitions) so colours are final. */
async function settle(page: Page): Promise<void> {
  // Vuetify starts some transitions a frame after the element appears.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity,
      ),
  );
}
