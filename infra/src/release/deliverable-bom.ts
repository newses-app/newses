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

const USAGE = `Usage: build-sbom.ts --deliverable ${DELIVERABLES.join('|')} --out DIR [--tag TAG] [--input FILE]`;

/** build-sbom.ts's options, checked: a known deliverable, and `--input` exactly when it takes one. */
export function checkSbomOptions(options: { deliverable?: string; out?: string; input?: string }): {
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
  return { deliverable, out: options.out };
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
  return splice(mergeBoms(inputs, deliverableRoot(deliverable, version, repository)), isFirstParty);
}
