// Third-party work the apps ship or adapt, credited in the About tab and CREDITS.md (`pnpm
// credits`). Every bundled package also gets its licence text from the build; these are the ones
// worth naming. No Zod, so browsers can import it.

export const CREDIT_KINDS = [
  'framework',
  'font',
  'icons',
  'palette',
  'data',
  'translations',
] as const;
export type CreditKind = (typeof CREDIT_KINDS)[number];

export interface Credit {
  name: string;
  /** The copyright holder. */
  author: string;
  url: string;
  /** SPDX identifier. */
  license: string;
  kind: CreditKind;
  /** The npm package that ships it; the build collects its licence text. */
  package?: string;
  /** For work no package ships: its copyright line, shown in its licence text. */
  copyright?: string;
}

/** A package a build bundles, with the texts it ships; `third-party-licenses.ts` collects them. */
export interface ThirdPartyLicense {
  name: string;
  version: string;
  /** SPDX expression from its package.json, or `UNKNOWN`. */
  license: string;
  text?: string;
  /** Apache-2.0's NOTICE, which travels with the work. */
  notice?: string;
  /** Where to read the licence when the package ships no text (Android libraries). */
  url?: string;
}

/** Where the web build writes its packages' licences, next to index.html. */
export const THIRD_PARTY_LICENSES_FILE = 'third-party-licenses.json';
/** What the desktop and Android shells bundle beyond the web build, beside it. */
export const PLATFORM_LICENSES_FILE = 'third-party-licenses-platform.json';

export const CREDITS = {
  vue: {
    name: 'Vue',
    author: 'Yuxi (Evan) You',
    url: 'https://vuejs.org',
    license: 'MIT',
    kind: 'framework',
    package: 'vue',
  },
  vuetify: {
    name: 'Vuetify',
    author: 'Vuetify, LLC',
    url: 'https://vuetifyjs.com',
    license: 'MIT',
    kind: 'framework',
    package: 'vuetify',
  },
  electron: {
    name: 'Electron',
    author: 'Electron contributors',
    url: 'https://www.electronjs.org',
    license: 'MIT',
    kind: 'framework',
    package: 'electron',
  },
  capacitor: {
    name: 'Capacitor',
    author: 'Drifty Co.',
    url: 'https://capacitorjs.com',
    license: 'MIT',
    kind: 'framework',
    package: '@capacitor/core',
  },
  plexMono: {
    name: 'IBM Plex Mono',
    author: 'IBM Corp.',
    url: 'https://github.com/IBM/plex',
    license: 'OFL-1.1',
    kind: 'font',
    package: '@fontsource/ibm-plex-mono',
  },
  patrickHand: {
    name: 'Patrick Hand',
    author: 'Patrick Wagesreiter',
    url: 'https://fonts.google.com/specimen/Patrick+Hand',
    license: 'OFL-1.1',
    kind: 'font',
    package: '@fontsource/patrick-hand',
  },
  courierPrime: {
    name: 'Courier Prime',
    author: 'The Courier Prime Project Authors',
    url: 'https://github.com/quoteunquoteapps/CourierPrime',
    license: 'OFL-1.1',
    kind: 'font',
    package: '@fontsource/courier-prime',
  },
  oswald: {
    name: 'Oswald',
    author: 'The Oswald Project Authors',
    url: 'https://github.com/googlefonts/OswaldFont',
    license: 'OFL-1.1',
    kind: 'font',
    package: '@fontsource/oswald',
  },
  mdi: {
    name: 'Material Design Icons',
    author: 'Pictogrammers',
    url: 'https://pictogrammers.com/library/mdi/',
    license: 'Apache-2.0',
    kind: 'icons',
    package: '@mdi/js',
  },
  catppuccin: {
    name: 'Catppuccin',
    author: 'Catppuccin',
    url: 'https://catppuccin.com',
    license: 'MIT',
    kind: 'palette',
    copyright: 'Copyright (c) 2021 Catppuccin',
  },
  solarized: {
    name: 'Solarized',
    author: 'Ethan Schoonover',
    url: 'https://ethanschoonover.com/solarized/',
    license: 'MIT',
    kind: 'palette',
    copyright: 'Copyright (c) 2011 Ethan Schoonover',
  },
  gruvbox: {
    name: 'Gruvbox',
    author: 'Pavel Pertsev',
    url: 'https://github.com/morhetz/gruvbox',
    license: 'MIT',
    kind: 'palette',
    copyright: 'Copyright (c) 2012 Pavel Pertsev',
  },
  secLists: {
    name: 'SecLists',
    author: 'Daniel Miessler',
    url: 'https://github.com/danielmiessler/SecLists',
    license: 'MIT',
    kind: 'data',
    copyright: 'Copyright (c) 2018 Daniel Miessler',
  },
  oramaStemmers: {
    name: 'Orama stemmers',
    author: 'OramaSearch Inc.',
    url: 'https://github.com/oramasearch/orama/tree/main/packages/stemmers',
    license: 'Apache-2.0',
    kind: 'data',
    package: '@orama/stemmers',
  },
  vuetifyLocales: {
    name: 'Vuetify translations',
    author: 'Vuetify contributors',
    url: 'https://github.com/vuetifyjs/vuetify/tree/master/packages/vuetify/src/locale',
    license: 'MIT',
    kind: 'translations',
    package: 'vuetify',
  },
} as const satisfies Record<string, Credit>;
export type CreditKey = keyof typeof CREDITS;

/** The licence text of work no package ships; every such credit is MIT. */
export function mitLicense(copyright: string): string {
  return `MIT License

${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}
