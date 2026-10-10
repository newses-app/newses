// Regenerates the Android launcher icons and splash screens from the web app's icon
// (web/public/favicon.svg) with @capacitor/assets. Run after the icon changes; the results in
// android/ are committed.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const svg = await readFile(
  fileURLToPath(new URL('../../web/public/favicon.svg', import.meta.url)),
  'utf8',
);
const BRAND = '#e8710a';

// The glyph without its rounded square, for the adaptive icon's foreground over the brand colour.
const glyph = svg.replace(/<rect[^>]*\/>/, '');
// Adaptive icons show the middle 66 of 108 units; keep the glyph inside it.
const foreground = glyph.replace('viewBox="0 0 64 64"', 'viewBox="-22 -22 108 108"');

await mkdir(`${root}assets`, { recursive: true });
await writeFile(`${root}assets/icon-only.svg`, svg);
await writeFile(`${root}assets/icon-foreground.svg`, foreground);
await writeFile(
  `${root}assets/icon-background.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${BRAND}"/></svg>`,
);

// Splash screens: the icon, small, in the middle of the light and dark backgrounds.
const splash = (background: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2732 2732"><rect width="2732" height="2732" fill="${background}"/><svg x="1166" y="1166" width="400" height="400" viewBox="0 0 64 64">${svg.trim().replace(/^<svg[^>]*>|<\/svg>$/g, '')}</svg></svg>`;
await writeFile(`${root}assets/splash.svg`, splash('#ffffff'));
await writeFile(`${root}assets/splash-dark.svg`, splash('#121212'));

const result = spawnSync(
  'pnpm',
  [
    '--allow-build=sharp',
    'dlx',
    '@capacitor/assets@3',
    'generate',
    '--android',
    '--iconBackgroundColor',
    BRAND,
    '--iconBackgroundColorDark',
    BRAND,
    '--splashBackgroundColor',
    '#ffffff',
    '--splashBackgroundColorDark',
    '#121212',
  ],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
);
process.exit(result.status ?? 1);
