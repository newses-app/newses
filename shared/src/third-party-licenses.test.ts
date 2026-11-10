import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  installedPackages,
  mavenLicenses,
  mergeLicenses,
  packageLicenses,
} from './third-party-licenses.ts';

const root = mkdtempSync(join(tmpdir(), 'licenses-'));
afterAll(() => {
  rmSync(root, { recursive: true });
});

function pkg(dir: string, manifest: object, files: Record<string, string> = {}) {
  mkdirSync(join(root, dir, 'dist'), { recursive: true });
  writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(root, dir, 'dist', 'index.js'), '');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, dir, name), text);
  return join(root, dir, 'dist', 'index.js');
}

describe('packageLicenses', () => {
  it('reads each bundled package once, with its licence and notice texts', () => {
    const plain = pkg(
      'node_modules/plain',
      { name: 'plain', version: '1.0.0', license: 'MIT' },
      { 'LICENSE.md': 'MIT text\n', 'LICENSE-MIT': 'other' },
    );
    const scoped = pkg(
      'node_modules/.pnpm/@scope+lib@2.0.0/node_modules/@scope/lib',
      { name: '@scope/lib', version: '2.0.0', license: { type: 'Apache-2.0' } },
      { LICENSE: 'Apache text', NOTICE: 'Notice text' },
    );
    const bare = pkg('node_modules/bare', { name: 'bare', version: '0.1.0' });
    // Vendored without a package.json: the enclosing package's.
    const vendored = join(root, 'node_modules/plain/dist/node_modules/inner/index.js');
    mkdirSync(join(vendored, '..'), { recursive: true });
    writeFileSync(vendored, '');
    expect(
      packageLicenses([
        `${scoped}?vue&type=script`,
        plain,
        `${plain}#hash`,
        bare,
        vendored,
        '\0virtual:module',
        join(root, 'src', 'first-party.ts'),
      ]),
    ).toEqual([
      {
        name: '@scope/lib',
        version: '2.0.0',
        license: 'Apache-2.0',
        text: 'Apache text',
        notice: 'Notice text',
      },
      { name: 'bare', version: '0.1.0', license: 'UNKNOWN' },
      { name: 'plain', version: '1.0.0', license: 'MIT', text: 'MIT text' },
    ]);
  });

  it('merges builds by name and version', () => {
    const a = { name: 'a', version: '1.0.0', license: 'MIT' };
    const b = { name: 'b', version: '1.0.0', license: 'MIT' };
    expect(mergeLicenses([b, a], [a, { ...a, version: '0.9.0' }])).toEqual([
      { ...a, version: '0.9.0' },
      a,
      b,
    ]);
  });
});

describe('mavenLicenses', () => {
  it('names Android libraries by coordinates, with where to read their licence', () => {
    const maven = (name: string, licenses: object[]) => ({
      group: 'org.example',
      name,
      version: '1.0',
      purl: `pkg:maven/org.example/${name}@1.0`,
      licenses,
    });
    expect(
      mavenLicenses({
        components: [
          maven('plain', [{ license: { id: 'Apache-2.0' } }]),
          maven('dual', [{ license: { id: 'MIT' } }, { license: { id: 'Apache-2.0' } }]),
          maven('named', [{ license: { name: 'License', url: 'https://example.com/LICENSE' } }]),
          { ...maven('npm', []), purl: 'pkg:npm/npm@1.0' },
          {
            ...maven('project', []),
            purl: 'pkg:maven/android/capacitor-app@unspecified?project_path=%3Acapacitor-app',
          },
          {
            group: 'io.ionic.libs',
            name: 'ionfilesystem-android',
            version: '1.1.1',
            purl: 'pkg:maven/io.ionic.libs/ionfilesystem-android@1.1.1?type=aar',
            licenses: [{ license: { name: 'License', url: 'https://example.com/ion' } }],
          },
        ],
      }),
    ).toEqual([
      {
        name: 'io.ionic.libs:ionfilesystem-android',
        version: '1.1.1',
        license: 'MIT',
        url: 'https://example.com/ion',
      },
      { name: 'org.example:dual', version: '1.0', license: 'MIT AND Apache-2.0' },
      {
        name: 'org.example:named',
        version: '1.0',
        license: 'UNKNOWN',
        url: 'https://example.com/LICENSE',
      },
      {
        name: 'org.example:plain',
        version: '1.0',
        license: 'Apache-2.0',
        url: 'https://spdx.org/licenses/Apache-2.0.html',
      },
    ]);
  });
});

describe('installedPackages', () => {
  it("finds packages in pnpm's and npm's layouts, without linked workspace packages", () => {
    const modules = join(root, 'install', 'node_modules');
    pkg('install/node_modules/.pnpm/a@1.0.0/node_modules/a', { name: 'a', version: '1.0.0' });
    pkg('install/node_modules/.pnpm/@s+b@1.0.0/node_modules/@s/b', { name: '@s/b', version: '1' });
    pkg('install/node_modules/c', { name: 'c', version: '1.0.0' });
    pkg('install/node_modules/c/node_modules/d', { name: 'd', version: '1.0.0' });
    pkg('install/workspace', { name: '@newses/x', version: '0.0.0' });
    mkdirSync(join(modules, '@newses'), { recursive: true });
    symlinkSync(join(root, 'install', 'workspace'), join(modules, '@newses', 'x'));
    expect(packageLicenses(installedPackages(modules)).map((entry) => entry.name)).toEqual([
      '@s/b',
      'a',
      'c',
      'd',
    ]);
  });
});
