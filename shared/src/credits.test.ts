import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CREDITS, type Credit } from './credits.ts';
import { CREDITS_MD, creditsMarkdown } from './credits-md.ts';
import { BUILTIN_THEME_ADAPTED_FROM } from './themes-builtin.ts';

const credits: [string, Credit][] = Object.entries(CREDITS);

// Every package the shipped workspace packages depend on, build tools included.
const dependencies = new Set(
  ['web', 'desktop', 'mobile'].flatMap((name) => {
    const manifest = JSON.parse(
      readFileSync(new URL(`../../${name}/package.json`, import.meta.url), 'utf8'),
    ) as Record<string, Record<string, string> | undefined>;
    return [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];
  }),
);

describe('credits', () => {
  it('names a package or carries an MIT copyright line', () => {
    for (const [key, credit] of credits) {
      if (credit.package) expect(dependencies, key).toContain(credit.package);
      else expect(credit.license === 'MIT' && Boolean(credit.copyright), key).toBe(true);
    }
  });

  it('credits each palette with the built-ins adapted from it', () => {
    const adaptedFrom = new Set(Object.values(BUILTIN_THEME_ADAPTED_FROM));
    for (const [key, credit] of credits)
      expect(adaptedFrom.has(key as keyof typeof CREDITS), key).toBe(credit.kind === 'palette');
  });

  it('keeps CREDITS.md current (pnpm credits)', () => {
    expect(readFileSync(CREDITS_MD, 'utf8')).toBe(creditsMarkdown());
  });
});
