import { describe, expect, it } from 'vitest';
import { declarationImports, publishManifest } from './publish.ts';

describe('publishManifest', () => {
  it('versions the package and points its exports at the built files', () => {
    const manifest = publishManifest(
      {
        name: '@newses/plugin-api',
        private: true,
        description: 'The contract',
        license: 'AGPL-3.0-or-later',
        exports: { '.': './src/index.ts', './testing': './src/testing.ts' },
        scripts: { typecheck: 'tsc' },
        peerDependencies: { zod: '^4.6.7' },
        devDependencies: { zod: '^4.6.7' },
      },
      '0.1.0',
    );
    expect(manifest).toMatchObject({
      name: '@newses/plugin-api',
      version: '0.1.0',
      type: 'module',
      exports: {
        '.': { types: './index.d.ts', default: './index.js' },
        './testing': { types: './testing.d.ts', default: './testing.js' },
      },
      peerDependencies: { zod: '^4.6.7' },
    });
    expect(manifest).not.toHaveProperty('private');
    expect(manifest).not.toHaveProperty('scripts');
    expect(manifest).not.toHaveProperty('devDependencies');
  });
});

describe('declarationImports', () => {
  it('imports declarations by .js, as the JavaScript does', () => {
    expect(
      declarationImports(`import { type A } from './index.ts';\nimport { z } from 'zod';`),
    ).toBe(`import { type A } from './index.js';\nimport { z } from 'zod';`);
  });
});
