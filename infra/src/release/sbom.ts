// CycloneDX SBOMs for what we ship, one per deliverable, composed from `pnpm sbom`, the Android
// Gradle plugin, and syft (build-sbom.ts runs them). Every source writes CycloneDX 1.6.
import { randomUUID } from 'node:crypto';

export const SPEC_VERSION = '1.6';

export interface Component {
  type: string;
  name: string;
  'bom-ref'?: string;
  group?: string;
  version?: string;
  purl?: string;
  [key: string]: unknown;
}

export interface Dependency {
  ref: string;
  dependsOn?: string[];
}

export interface Bom {
  bomFormat: 'CycloneDX';
  specVersion: string;
  serialNumber?: string;
  version?: number;
  metadata?: {
    timestamp?: string;
    tools?: { components?: Component[] };
    component?: Component;
    [key: string]: unknown;
  };
  components?: Component[];
  dependencies?: Dependency[];
  [key: string]: unknown;
}

export const DELIVERABLES = ['server', 'image', 'web', 'desktop', 'mobile'] as const;
export type Deliverable = (typeof DELIVERABLES)[number];

/** A workspace package's `pnpm sbom`, cut to what the deliverable ships when `keep` is set. */
export interface PnpmSource {
  filter: string;
  /** Only `dependencies`; bundled packages list what they ship as devDependencies. */
  prod: boolean;
  keep?: Selection;
}

export interface DeliverableSources {
  pnpm: PnpmSource[];
  /** The Android app's release runtime classpath. */
  gradle?: boolean;
  /** An SBOM made elsewhere (syft on the Docker image). */
  input?: boolean;
}

export const SOURCES: Record<Deliverable, DeliverableSources> = {
  server: { pnpm: [{ filter: '@newses/server', prod: true }] },
  image: { pnpm: [], input: true },
  web: { pnpm: [{ filter: '@newses/web', prod: true }] },
  // esbuild bundles the main process, so desktop has only devDependencies: of those, the app
  // ships electron-updater and runs on Electron (whose own dependencies only install it).
  desktop: {
    pnpm: [
      { filter: '@newses/web', prod: true },
      {
        filter: '@newses/desktop',
        prod: false,
        keep: { components: ['electron'], closures: ['electron-updater'] },
      },
    ],
  },
  mobile: {
    pnpm: [
      { filter: '@newses/web', prod: true },
      { filter: '@newses/mobile', prod: true },
    ],
    gradle: true,
  },
};

/** The file a deliverable's SBOM is written to, beside the installers' naming. */
export const sbomName = (version: string, deliverable: Deliverable) =>
  `newses-${version}-${deliverable}.cdx.json`;

const SBOM_NAME = /^newses-(.+)-([a-z]+)\.cdx\.json$/;

/** The version and deliverable in an SBOM's file name, or undefined for another file. */
export function parseSbomName(name: string) {
  const match = SBOM_NAME.exec(name);
  const deliverable = match?.[2] as Deliverable | undefined;
  if (!match?.[1] || !deliverable || !DELIVERABLES.includes(deliverable)) return undefined;
  return { version: match[1], deliverable };
}

const packageName = (component: Component) =>
  component.group ? `${component.group}/${component.name}` : component.name;

const refOf = (component: Component) => component['bom-ref'] ?? component.purl ?? '';

const dependsOn = (bom: Bom) =>
  new Map((bom.dependencies ?? []).map((d) => [d.ref, d.dependsOn ?? []]));

/** Packages to keep: just the named components, and the named ones with all they depend on. */
export interface Selection {
  components?: string[];
  closures?: string[];
}

/** The root and the selected packages; the root depends on the selected ones directly. */
export function select(bom: Bom, selection: Selection): Bom {
  const graph = dependsOn(bom);
  const components = bom.components ?? [];
  const named = (names: string[] = []) =>
    components.filter((c) => names.includes(packageName(c))).map(refOf);
  const direct = [...named(selection.components), ...named(selection.closures)];
  const kept = new Set(named(selection.components));
  const pending = named(selection.closures);
  for (let ref = pending.pop(); ref !== undefined; ref = pending.pop()) {
    if (kept.has(ref)) continue;
    kept.add(ref);
    pending.push(...(graph.get(ref) ?? []));
  }
  const missing = [...(selection.components ?? []), ...(selection.closures ?? [])].filter(
    (name) => !components.some((c) => packageName(c) === name),
  );
  if (missing.length > 0) throw new Error(`Not in the SBOM: ${missing.join(', ')}`);

  const root = bom.metadata?.component;
  const rootRef = root ? refOf(root) : undefined;
  return {
    ...bom,
    components: components.filter((c) => kept.has(refOf(c))),
    dependencies: [
      ...(rootRef ? [{ ref: rootRef, dependsOn: direct }] : []),
      ...(bom.dependencies ?? [])
        .filter((d) => kept.has(d.ref))
        .map((d) => ({ ...d, dependsOn: (d.dependsOn ?? []).filter((ref) => kept.has(ref)) })),
    ],
  };
}

/**
 * Removes components (and their dependency entries), pointing whatever depended on them at
 * what they depended on, so the rest of the graph survives.
 */
export function splice(bom: Bom, drop: (component: Component) => boolean): Bom {
  const dropped = new Set((bom.components ?? []).filter(drop).map(refOf));
  const graph = dependsOn(bom);
  const resolve = (refs: string[], seen = new Set<string>()): string[] =>
    refs.flatMap((ref) => {
      if (!dropped.has(ref)) return [ref];
      if (seen.has(ref)) return [];
      seen.add(ref);
      return resolve(graph.get(ref) ?? [], seen);
    });
  return {
    ...bom,
    components: (bom.components ?? []).filter((c) => !dropped.has(refOf(c))),
    dependencies: (bom.dependencies ?? [])
      .filter((d) => !dropped.has(d.ref))
      .map((d) => ({ ...d, dependsOn: [...new Set(resolve(d.dependsOn ?? []))] })),
  };
}

/**
 * Workspace packages are part of the deliverable, and the Android plugin lists the Capacitor
 * Gradle projects (unversioned; their npm packages already list them) as components.
 */
export const isFirstParty = (component: Component) =>
  component.purl?.startsWith('pkg:npm/%40newses/') === true ||
  component.purl?.includes('project_path=') === true;

/** The deliverable's root component, with the source repository's URL when there is one. */
export function deliverableRoot(
  deliverable: Deliverable,
  version: string,
  repository?: string,
): Component {
  const name = `newses-${deliverable}`;
  return {
    type: deliverable === 'image' ? 'container' : 'application',
    'bom-ref': `${name}@${version}`,
    name,
    version,
    licenses: [{ license: { id: 'AGPL-3.0-or-later' } }],
    ...(repository && { externalReferences: [{ type: 'vcs', url: repository }] }),
  };
}

/**
 * One SBOM from several: the components and dependencies of each, deduplicated by reference,
 * under `root`, which depends on what each input's root depended on.
 */
export function mergeBoms(inputs: Bom[], root: Component, now = new Date()): Bom {
  const rootRef = refOf(root);
  const components = new Map<string, Component>();
  const graph = new Map<string, Set<string>>([[rootRef, new Set()]]);
  const tools = new Map<string, Component>();
  const edges = (ref: string) => {
    let set = graph.get(ref);
    if (!set) graph.set(ref, (set = new Set()));
    return set;
  };
  for (const input of inputs) {
    if (input.specVersion !== SPEC_VERSION) {
      throw new Error(`Expected CycloneDX ${SPEC_VERSION}, got ${input.specVersion}`);
    }
    const inputRoot = input.metadata?.component ? refOf(input.metadata.component) : undefined;
    for (const component of input.components ?? []) {
      const ref = refOf(component);
      if (!components.has(ref)) components.set(ref, component);
    }
    for (const dependency of input.dependencies ?? []) {
      const target = dependency.ref === inputRoot ? rootRef : dependency.ref;
      for (const ref of dependency.dependsOn ?? []) edges(target).add(ref);
    }
    for (const tool of input.metadata?.tools?.components ?? []) {
      tools.set(`${packageName(tool)}@${tool.version ?? ''}`, tool);
    }
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: SPEC_VERSION,
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: now.toISOString(),
      lifecycles: [{ phase: 'build' }],
      tools: { components: [...tools.values()] },
      component: root,
    },
    components: [...components.values()],
    dependencies: [...graph].map(([ref, set]) => ({ ref, dependsOn: [...set] })),
  };
}

/**
 * Names the files a release SBOM describes, by download URL and SHA-256, so the SBOM can be
 * matched to the installer someone has.
 */
export function addDistributions(bom: Bom, files: { url: string; sha256: string }[]): Bom {
  const root = bom.metadata?.component;
  if (!root) throw new Error('The SBOM has no root component');
  const existing = Array.isArray(root.externalReferences)
    ? (root.externalReferences as unknown[])
    : [];
  return {
    ...bom,
    metadata: {
      ...bom.metadata,
      component: {
        ...root,
        externalReferences: [
          ...existing,
          ...files.map((file) => ({
            type: 'distribution',
            url: file.url,
            hashes: [{ alg: 'SHA-256', content: file.sha256 }],
          })),
        ],
      },
    },
  };
}
