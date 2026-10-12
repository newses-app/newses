import { describe, expect, it } from 'vitest';
import {
  addDistributions,
  type Bom,
  type Component,
  deliverableRoot,
  isFirstParty,
  mergeBoms,
  parseSbomName,
  sbomName,
  select,
  splice,
} from './sbom.ts';

const npm = (name: string, version = '1.0.0'): Component => {
  const ref = `pkg:npm/${name.replace('@', '%40')}@${version}`;
  const slash = name.indexOf('/');
  const group = name.startsWith('@') ? name.slice(0, slash) : undefined;
  const bare = group ? name.slice(slash + 1) : name;
  return { type: 'library', name: bare, group, version, purl: ref, 'bom-ref': ref };
};
const ref = (component: Component) => component['bom-ref'] ?? '';

const bom = (root: Component, components: Component[], graph: [Component, Component[]][]) =>
  ({
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    metadata: {
      component: root,
      tools: { components: [{ type: 'application', name: 'pnpm', version: '11.11.0' }] },
    },
    components,
    dependencies: graph.map(([from, to]) => ({ ref: ref(from), dependsOn: to.map(ref) })),
  }) satisfies Bom;

const dependenciesOf = (result: Bom) =>
  Object.fromEntries((result.dependencies ?? []).map((d) => [d.ref, d.dependsOn ?? []]));

// A bundled package: everything it lists is a devDependency.
const desktop = npm('@newses/desktop', '0.0.0');
const electron = npm('electron', '44.7.0');
const get = npm('@electron/get');
const updater = npm('electron-updater', '6.8.9');
const semver = npm('semver', '7.7.4');
const builder = npm('electron-builder', '26.15.3');
const desktopBom = bom(
  desktop,
  [electron, get, updater, semver, builder],
  [
    [desktop, [electron, updater, builder]],
    [electron, [get]],
    [updater, [semver]],
    [builder, [semver]],
  ],
);

describe('select', () => {
  it('keeps named components alone and named closures whole, under the root', () => {
    const result = select(desktopBom, { components: ['electron'], closures: ['electron-updater'] });
    expect(result.components?.map((c) => c.name)).toEqual([
      'electron',
      'electron-updater',
      'semver',
    ]);
    expect(dependenciesOf(result)).toEqual({
      [ref(desktop)]: [ref(electron), ref(updater)],
      [ref(electron)]: [],
      [ref(updater)]: [ref(semver)],
    });
  });

  it('refuses a package the SBOM does not have', () => {
    expect(() => select(desktopBom, { closures: ['electron-updatr'] })).toThrow(/electron-updatr/);
  });
});

describe('splice', () => {
  it('drops components and points their dependents at their dependencies', () => {
    const web = npm('@newses/web', '0.0.0');
    const shared = npm('@newses/shared', '0.0.0');
    const zod = npm('zod', '4.6.5');
    const vue = npm('vue', '3.5.43');
    const result = splice(
      bom(
        web,
        [shared, zod, vue],
        [
          [web, [shared, vue]],
          [shared, [zod]],
        ],
      ),
      isFirstParty,
    );
    expect(result.components?.map((c) => c.name)).toEqual(['zod', 'vue']);
    expect(dependenciesOf(result)).toEqual({ [ref(web)]: [ref(zod), ref(vue)] });
  });
});

describe('isFirstParty', () => {
  it('matches workspace packages and Gradle projects only', () => {
    expect(isFirstParty(npm('@newses/shared'))).toBe(true);
    expect(
      isFirstParty({
        type: 'library',
        name: 'capacitor-android',
        purl: 'pkg:maven/android/capacitor-android@unspecified?project_path=%3Acapacitor-android',
      }),
    ).toBe(true);
    expect(isFirstParty(npm('@capacitor/android'))).toBe(false);
  });
});

describe('mergeBoms', () => {
  const web = npm('@newses/web', '0.0.0');
  const vue = npm('vue', '3.5.43');
  const webBom = bom(web, [vue, semver], [[web, [vue, semver]]]);
  const root = deliverableRoot('desktop', '1.2.3');
  const now = new Date('2026-10-12T12:00:00Z');

  it("puts every input's components under the root, once each", () => {
    const desktopPart = select(desktopBom, { closures: ['electron-updater'] });
    const result = mergeBoms([webBom, desktopPart], root, now);
    expect(result.metadata).toEqual(
      expect.objectContaining({ timestamp: '2026-10-12T12:00:00.000Z', component: root }),
    );
    expect(result.metadata?.tools?.components).toHaveLength(1);
    expect(result.serialNumber).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(result.components?.map((c) => c.name)).toEqual(['vue', 'semver', 'electron-updater']);
    expect(dependenciesOf(result)).toEqual({
      'newses-desktop@1.2.3': [ref(vue), ref(semver), ref(updater)],
      [ref(updater)]: [ref(semver)],
    });
  });

  it('refuses another CycloneDX version', () => {
    expect(() => mergeBoms([{ ...webBom, specVersion: '1.7' }], root, now)).toThrow(/1\.6/);
  });
});

describe('deliverableRoot', () => {
  it('names the deliverable, and types the image as a container', () => {
    expect(deliverableRoot('server', '1.2.3')).toEqual(
      expect.objectContaining({
        type: 'application',
        name: 'newses-server',
        version: '1.2.3',
        'bom-ref': 'newses-server@1.2.3',
      }),
    );
    expect(deliverableRoot('image', '1.2.3').type).toBe('container');
  });

  it('links the source repository only when it is known', () => {
    expect(deliverableRoot('web', '1.2.3').externalReferences).toBeUndefined();
    expect(deliverableRoot('web', '1.2.3', 'https://github.com/owner/newses')).toEqual(
      expect.objectContaining({
        externalReferences: [{ type: 'vcs', url: 'https://github.com/owner/newses' }],
      }),
    );
  });
});

describe('sbomName', () => {
  it('round-trips the version and deliverable', () => {
    const name = sbomName('1.2.3-rc.1', 'mobile');
    expect(name).toBe('newses-1.2.3-rc.1-mobile.cdx.json');
    expect(parseSbomName(name)).toEqual({ version: '1.2.3-rc.1', deliverable: 'mobile' });
    expect(parseSbomName('newses-1.2.3-android.apk')).toBeUndefined();
    expect(parseSbomName('newses-1.2.3-docs.cdx.json')).toBeUndefined();
  });
});

describe('addDistributions', () => {
  it('names each file by URL and SHA-256 on the root, after its other references', () => {
    const root = deliverableRoot('mobile', '1.2.3', 'https://github.com/owner/newses');
    const result = addDistributions(mergeBoms([], root), [
      {
        url: 'https://reader.example.com/downloads/1.2.3/newses-1.2.3-android.apk',
        sha256: 'abc',
      },
    ]);
    expect(result.metadata?.component?.externalReferences).toEqual([
      { type: 'vcs', url: 'https://github.com/owner/newses' },
      {
        type: 'distribution',
        url: 'https://reader.example.com/downloads/1.2.3/newses-1.2.3-android.apk',
        hashes: [{ alg: 'SHA-256', content: 'abc' }],
      },
    ]);
  });
});
