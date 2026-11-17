import { describe, expect, it, vi } from 'vitest';
import { checkSbomOptions, deliverableBom, pluginsBom, pnpmSbomArgs } from './deliverable-bom.ts';
import type { Bom, Component } from './sbom.ts';

const npm = (name: string, version = '1.0.0'): Component => {
  const purl = `pkg:npm/${name.replace('@', '%40')}@${version}`;
  return { type: 'library', name, version, purl, 'bom-ref': purl };
};

/** A tool's SBOM: `root` depending on `direct`, which depend on nothing more unless `graph` says. */
const bom = (root: Component, direct: Component[], more: [Component, Component[]][] = []): Bom => ({
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  metadata: { component: root },
  components: [...direct, ...more.flatMap(([, to]) => to)],
  dependencies: [
    { ref: root['bom-ref'] ?? '', dependsOn: direct.map((c) => c['bom-ref'] ?? '') },
    ...more.map(([from, to]) => ({
      ref: from['bom-ref'] ?? '',
      dependsOn: to.map((c) => c['bom-ref'] ?? ''),
    })),
  ],
});

const shared = npm('@newses/shared', '0.0.0');
const vue = npm('vue', '3.5.0');
const electron = npm('electron', '44.7.0');
const get = npm('@electron/get');
const updater = npm('electron-updater', '6.8.9');
const semver = npm('semver', '7.7.4');
const builder = npm('electron-builder', '26.15.3');

const TOOL_BOMS: Record<string, Bom> = {
  '@newses/web': bom(npm('@newses/web', '0.0.0'), [shared, vue], [[shared, [vue]]]),
  '@newses/desktop': bom(
    npm('@newses/desktop', '0.0.0'),
    [electron, updater, builder],
    [
      [electron, [get]],
      [updater, [semver]],
    ],
  ),
  '@newses/mobile': bom(npm('@newses/mobile', '0.0.0'), []),
};

function readers(input?: Bom) {
  return {
    pnpm: vi.fn((args: string[]) => {
      const filter = args[args.indexOf('--filter') + 1] ?? '';
      const found = TOOL_BOMS[filter];
      if (!found) throw new Error(`No SBOM for ${filter}`);
      return found;
    }),
    gradle: vi.fn(() =>
      Promise.resolve(bom({ type: 'application', name: 'app', 'bom-ref': 'app' }, [npm('okio')])),
    ),
    input,
  };
}

const names = (result: Bom) => (result.components ?? []).map((c) => c.name).sort();

describe('checkSbomOptions', () => {
  it('takes a known deliverable and where to write it', () => {
    expect(checkSbomOptions({ deliverable: 'web', out: 'sbom' })).toEqual({
      deliverable: 'web',
      out: 'sbom',
    });
    expect(() => checkSbomOptions({ deliverable: 'docs', out: 'sbom' })).toThrow(/^Usage:/);
    expect(() => checkSbomOptions({ deliverable: 'web' })).toThrow(/^Usage:/);
  });

  it('takes --input only for the image, which needs it', () => {
    expect(() => checkSbomOptions({ deliverable: 'image', out: 'sbom' })).toThrow(
      'image needs --input',
    );
    expect(() => checkSbomOptions({ deliverable: 'web', out: 'sbom', input: 'x.json' })).toThrow(
      'web takes no --input',
    );
    expect(checkSbomOptions({ deliverable: 'image', out: 'sbom', input: 'syft.json' })).toEqual({
      deliverable: 'image',
      out: 'sbom',
    });
  });
});

describe('plugins', () => {
  it('are added to the server only', () => {
    expect(checkSbomOptions({ deliverable: 'server', out: 'sbom', plugins: 'dir' })).toEqual({
      deliverable: 'server',
      out: 'sbom',
    });
    expect(() => checkSbomOptions({ deliverable: 'web', out: 'sbom', plugins: 'dir' })).toThrow(
      'Only server takes --plugins',
    );
  });

  it("come from npm's SBOM, referenced by purl as the other sources do", async () => {
    // As npm sbom writes it: CycloneDX 1.5, components referenced by name@version.
    const npmBom: Bom = {
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      metadata: {
        component: {
          type: 'application',
          name: 'newses-plugins',
          'bom-ref': 'newses-plugins@0.0.0',
          purl: 'pkg:npm/newses-plugins@0.0.0',
        },
      },
      components: [
        { ...npm('@newses/plugin-webhook'), 'bom-ref': '@newses/plugin-webhook@1.0.0' },
        { ...npm('undici', '7.0.0'), 'bom-ref': 'undici@7.0.0' },
      ],
      dependencies: [
        { ref: 'newses-plugins@0.0.0', dependsOn: ['@newses/plugin-webhook@1.0.0'] },
        { ref: '@newses/plugin-webhook@1.0.0', dependsOn: ['undici@7.0.0'] },
        { ref: 'undici@7.0.0', dependsOn: [] },
      ],
    };
    const plugins = pluginsBom(npmBom);
    expect(plugins.specVersion).toBe('1.6');
    expect(plugins.components?.map((c) => c['bom-ref'])).toEqual([
      'pkg:npm/%40newses/plugin-webhook@1.0.0',
      'pkg:npm/undici@7.0.0',
    ]);
    expect(plugins.dependencies?.[1]).toEqual({
      ref: 'pkg:npm/%40newses/plugin-webhook@1.0.0',
      dependsOn: ['pkg:npm/undici@7.0.0'],
    });

    const result = await deliverableBom('web', '1.2.3', undefined, { ...readers(), plugins });
    expect(names(result)).toEqual(['@newses/plugin-webhook', 'undici', 'vue']);
    expect(
      result.dependencies?.find((d) => d.ref === result.metadata?.component?.['bom-ref']),
    ).toMatchObject({
      dependsOn: expect.arrayContaining(['pkg:npm/%40newses/plugin-webhook@1.0.0']) as unknown,
    });
  });
});

describe('pnpmSbomArgs', () => {
  it('asks pnpm for CycloneDX, only production dependencies where the source says', () => {
    expect(pnpmSbomArgs({ filter: '@newses/web', prod: true })).toEqual([
      '--silent',
      'sbom',
      '--sbom-format',
      'cyclonedx',
      '--sbom-spec-version',
      '1.6',
      '--filter',
      '@newses/web',
      '--prod',
    ]);
    expect(pnpmSbomArgs({ filter: '@newses/desktop', prod: false })).not.toContain('--prod');
  });
});

describe('deliverableBom', () => {
  it("merges the desktop's sources: what it ships, and none of the workspace's own packages", async () => {
    const sources = readers();
    const result = await deliverableBom('desktop', '1.2.3', 'https://git.example/newses', sources);
    expect(result.metadata?.component).toMatchObject({
      name: 'newses-desktop',
      version: '1.2.3',
      externalReferences: [{ type: 'vcs', url: 'https://git.example/newses' }],
    });
    // Electron on its own, electron-updater with what it needs; not the build tools.
    expect(names(result)).toEqual(['electron', 'electron-updater', 'semver', 'vue']);
    expect(sources.gradle).not.toHaveBeenCalled();
  });

  it("adds the Android app's Gradle SBOM to the mobile one", async () => {
    const sources = readers();
    const result = await deliverableBom('mobile', '1.2.3', undefined, sources);
    expect(names(result)).toEqual(['okio', 'vue']);
    expect(result.metadata?.component?.externalReferences).toBeUndefined();
  });

  it("is the image's from the SBOM given as --input", async () => {
    const sources = readers(bom(npm('newses-image'), [npm('openssl', '3.5.0')]));
    const result = await deliverableBom('image', '1.2.3', undefined, sources);
    expect(names(result)).toEqual(['openssl']);
    expect(result.metadata?.component?.type).toBe('container');
    expect(sources.pnpm).not.toHaveBeenCalled();
  });
});
