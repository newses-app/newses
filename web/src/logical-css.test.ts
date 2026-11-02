import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = import.meta.dirname;

/** The sources with CSS, by path from `src`. */
const sources = readdirSync(ROOT, { recursive: true, encoding: 'utf8' })
  .filter((path) => /\.(vue|css)$/.test(path))
  .map((path) => [path, readFileSync(join(ROOT, path), 'utf8')] as const);

/** Declarations that name a physical side, so they don't flip with the document's direction. */
const PHYSICAL =
  /\b(?:margin|padding|border)-(?:left|right)\b|^\s*(?:left|right):|\b(?:text-align|float):\s*(?:left|right)\b|inset -?[1-9]/;

/** Physical on purpose: the window controls don't follow the document's direction. */
const ALLOWED = [
  'styles.css: left: env(titlebar-area-x, 0px);',
  'styles.css: padding-left: env(titlebar-area-x, 0px);',
  'styles.css: padding-right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw));',
];

/** The CSS of a source file: all of a `.css`, the `<style>` blocks of a `.vue`. */
const css = (path: string, source: string) =>
  path.endsWith('.css')
    ? source
    : [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((block) => block[1]).join('\n');

describe('stylesheets', () => {
  it('use logical properties, so layouts flip right to left', () => {
    const physical = sources.flatMap(([path, source]) =>
      css(path, source)
        .split('\n')
        .filter((line) => PHYSICAL.test(line))
        .map((line) => `${path}: ${line.trim()}`),
    );
    expect(physical.sort()).toEqual(ALLOWED);
  });
});
