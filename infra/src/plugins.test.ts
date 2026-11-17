import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installPlugins } from '@newses/server/install-plugins';
import { build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, type StageConfig } from './config.ts';
import { STAGES } from './deploy-config.ts';
import { pluginAliases, pluginsDir } from './plugins.ts';

const [dev] = STAGES;
if (!dev) throw new Error('a dev stage is configured');
const scratch = mkdtempSync(join(tmpdir(), 'plugins-'));
// Under server/, as plugins:install installs them, so the plugin resolves the server's packages.
const dir = join(REPO_ROOT, 'server', '.plugins', `test-infra-${String(process.pid)}`);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const withPlugins = (plugins: string[] | undefined): StageConfig => ({ ...dev, plugins });

describe('stage plugins', () => {
  it('are installed per stage under server/', () => {
    expect(pluginsDir(dev)).toBe(join(REPO_ROOT, 'server', '.plugins', 'dev'));
  });

  it('bundle into a function through #installed-plugins, once installed as listed', async () => {
    const plugin = join(scratch, 'fixture');
    mkdirSync(plugin);
    writeFileSync(
      join(plugin, 'package.json'),
      JSON.stringify({
        name: 'newses-plugin-fixture',
        version: '1.2.3',
        type: 'module',
        main: 'index.js',
        peerDependencies: { zod: '^4.0.0', '@newses/plugin-api': '^0.1.0' },
      }),
    );
    writeFileSync(
      join(plugin, 'index.js'),
      `import { definePlugin, secret } from '@newses/plugin-api';
import { z } from 'zod';
export default definePlugin({
  id: 'fixture', version: '1.2.3', apiVersion: '^0.1', scopes: ['instance'],
  settings: { instance: z.object({ key: secret() }) }, hooks: {},
});
`,
    );
    const stage = withPlugins(['newses-plugin-fixture@1.2.3']);
    expect(() => pluginAliases(stage, dir)).toThrow('plugins:install');
    expect(pluginAliases(withPlugins(undefined), dir)).toEqual({});

    installPlugins({
      dir,
      specs: stage.plugins ?? [],
      audit: false,
      sources: { 'newses-plugin-fixture': `file:${plugin}` },
    });
    const alias = pluginAliases(stage, dir);
    expect(() => pluginAliases(withPlugins(['newses-plugin-fixture@1.2.4']), dir)).toThrow(
      'not installed as its deployment config lists them',
    );

    // As the functions are bundled: the server's import of the list, aliased.
    const outfile = join(scratch, 'bundle.mjs');
    await build({
      stdin: {
        contents: `export { INSTALLED_PLUGINS } from '#installed-plugins';`,
        resolveDir: join(REPO_ROOT, 'server', 'src', 'plugins'),
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile,
      alias,
      logLevel: 'silent',
    });
    const { INSTALLED_PLUGINS } = (await import(pathToFileURL(outfile).href)) as {
      INSTALLED_PLUGINS: { source: string; plugin: { id: string } }[];
    };
    expect(INSTALLED_PLUGINS.map((p) => [p.source, p.plugin.id])).toEqual([
      ['newses-plugin-fixture@1.2.3', 'fixture'],
    ]);
  });
});
