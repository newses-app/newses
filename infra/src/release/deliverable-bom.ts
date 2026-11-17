// A deliverable's SBOM from its sources (sbom.ts SOURCES), for build-sbom.ts, which runs the tools.
import {
  type Bom,
  type Deliverable,
  DELIVERABLES,
  deliverableRoot,
  isFirstParty,
  mergeBoms,
  type PnpmSource,
  SOURCES,
  SPEC_VERSION,
  select,
  splice,
} from './sbom.ts';

const USAGE = `Usage: build-sbom.ts --deliverable ${DELIVERABLES.join('|')} --out DIR [--tag TAG] [--input FILE] [--plugins DIR]`;

/** build-sbom.ts's options, checked: a known deliverable, and `--input` exactly when it takes one. */
export function checkSbomOptions(options: {
  deliverable?: string;
  out?: string;
  input?: string;
  plugins?: string;
}): {
  deliverable: Deliverable;
  out: string;
} {
  const deliverable = DELIVERABLES.find((d) => d === options.deliverable);
  if (!deliverable || !options.out) throw new Error(USAGE);
  const takesInput = SOURCES[deliverable].input === true;
  if (takesInput !== Boolean(options.input)) {
    throw new Error(
      takesInput ? `${deliverable} needs --input` : `${deliverable} takes no --input`,
    );
  }
  if (options.plugins && deliverable !== 'server') throw new Error('Only server takes --plugins');
  return { deliverable, out: options.out };
}

/**
 * `npm sbom`'s SBOM of a deployment's installed plugins, as the other sources write theirs:
 * components referenced by purl, and CycloneDX 1.6, which only adds to npm's 1.5.
 */
export function pluginsBom(bom: Bom): Bom {
  const refs = new Map<string, string>();
  const withPurl = <T extends { 'bom-ref'?: string; purl?: string }>(component: T): T => {
    if (component['bom-ref'] && component.purl) refs.set(component['bom-ref'], component.purl);
    return component.purl ? { ...component, 'bom-ref': component.purl } : component;
  };
  const root = bom.metadata?.component && withPurl(bom.metadata.component);
  const components = (bom.components ?? []).map(withPurl);
  const ref = (r: string) => refs.get(r) ?? r;
  return {
    ...bom,
    specVersion: SPEC_VERSION,
    metadata: { ...bom.metadata, ...(root && { component: root }) },
    components,
    dependencies: (bom.dependencies ?? []).map((d) => ({
      ref: ref(d.ref),
      dependsOn: (d.dependsOn ?? []).map(ref),
    })),
  };
}

/** The arguments to `pnpm` for a workspace package's CycloneDX SBOM. */
export const pnpmSbomArgs = (source: PnpmSource) => [
  '--silent',
  'sbom',
  '--sbom-format',
  'cyclonedx',
  '--sbom-spec-version',
  SPEC_VERSION,
  '--filter',
  source.filter,
  ...(source.prod ? ['--prod'] : []),
];

/** Where the SBOMs a deliverable is made of come from. */
export interface BomReaders {
  /** `pnpm` run with these arguments, its output parsed. */
  pnpm: (args: string[]) => Bom;
  /** The Android app's Gradle SBOM, for deliverables with `gradle`. */
  gradle: () => Promise<Bom>;
  /** The `--input` SBOM, for deliverables that take one. */
  input?: Bom;
  /** A deployment's installed plugins (`pluginsBom`), added to the server's. */
  plugins?: Bom;
}

/**
 * The deliverable's SBOM: each source's, cut to what it ships, merged under the deliverable's root,
 * with the workspace's own packages spliced out.
 */
export async function deliverableBom(
  deliverable: Deliverable,
  version: string,
  repository: string | undefined,
  readers: BomReaders,
): Promise<Bom> {
  const sources = SOURCES[deliverable];
  const inputs = sources.pnpm.map((source) => {
    const bom = readers.pnpm(pnpmSbomArgs(source));
    return source.keep ? select(bom, source.keep) : bom;
  });
  if (sources.gradle) inputs.push(await readers.gradle());
  if (readers.input) inputs.push(readers.input);
  if (readers.plugins) inputs.push(readers.plugins);
  return splice(mergeBoms(inputs, deliverableRoot(deliverable, version, repository)), isFirstParty);
}
