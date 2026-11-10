// The licences of the packages a build bundles, from the paths of the files it took from
// node_modules: each package's name, version, licence, and its LICENSE and NOTICE texts. The apps
// show them in the About tab. Node only.
//
// The server's image and Lambda builds write theirs with:
//   node shared/src/third-party-licenses.ts --out FILE [--metafile FILE]... [--node-modules DIR]...
// from esbuild metafiles (paths relative to the working directory) and installed node_modules.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import type { ThirdPartyLicense } from './credits.ts';

/**
 * SPDX licences a shipped package may have: AGPL-3.0-compatible (ADR 0029), so permissive ones,
 * MPL-2.0, and (L)GPL-3.0, but not GPL-2.0-only. Fonts are OFL-1.1.
 */
export const ALLOWED_LICENSES: ReadonlySet<string> = new Set([
  '0BSD',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'ISC',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'OFL-1.1',
  'Python-2.0',
  'Unlicense',
  'Zlib',
]);

/**
 * Whether an SPDX expression is allowed: one of its `OR` choices has only allowed licences. Nested
 * parentheses count as allowed only when every licence in them is.
 */
export function licenseAllowed(expression: string): boolean {
  const inner = expression.trim().replace(/^\((.*)\)$/, '$1');
  const allowed = (ids: string) =>
    ids
      .replace(/[()]/g, ' ')
      .split(/\s+(?:AND|OR)\s+/)
      .every((id) => ALLOWED_LICENSES.has(id.trim()));
  if (/[()]/.test(inner)) return allowed(inner);
  return inner.split(/\s+OR\s+/).some(allowed);
}

/** Fails a build that would ship a package outside the policy, or one without a licence. */
export function checkLicenses<T extends Pick<ThirdPartyLicense, 'name' | 'version' | 'license'>>(
  licenses: T[],
): T[] {
  const refused = licenses.filter((entry) => !licenseAllowed(entry.license));
  if (refused.length > 0) {
    const list = refused.map((entry) => `${entry.name}@${entry.version} (${entry.license})`);
    throw new Error(`Licences outside the policy (ADR 0029): ${list.join(', ')}`);
  }
  return licenses;
}

const NODE_MODULES = `${sep}node_modules${sep}`;
const LICENSE_FILE = /^(licen[cs]e|copying)([.-].*)?$/i;
const NOTICE_FILE = /^notice(\..*)?$/i;

/**
 * The directory of the package a bundled file is in, or `undefined` outside node_modules. Code a
 * package vendors in node_modules of its own, without a package.json, counts as that package's.
 */
function packageRoot(file: string): string | undefined {
  const path = resolve(file.replace(/[?#].*$/, ''));
  for (
    let at = path.lastIndexOf(NODE_MODULES);
    at >= 0;
    at = path.lastIndexOf(NODE_MODULES, at - 1)
  ) {
    const start = at + NODE_MODULES.length;
    const segments = path.slice(start).split(sep);
    const name = segments[0]?.startsWith('@') ? segments.slice(0, 2) : segments.slice(0, 1);
    const root = join(path.slice(0, start), ...name);
    if (existsSync(join(root, 'package.json'))) return root;
  }
  return undefined;
}

function readFirst(dir: string, files: string[], pattern: RegExp): string | undefined {
  // LICENSE before LICENSE-MIT or LICENSE.md, when a package has several.
  const file = files.filter((name) => pattern.test(name)).sort((a, b) => a.length - b.length)[0];
  return file && readFileSync(join(dir, file), 'utf8').trim();
}

function licenseOf(field: unknown): string {
  if (typeof field === 'string') return field;
  if (field && typeof field === 'object' && 'type' in field) return String(field.type);
  return 'UNKNOWN';
}

/** One entry per package and version, by name; files outside node_modules are first-party. */
export function packageLicenses(files: Iterable<string>): ThirdPartyLicense[] {
  const roots = new Set<string>();
  for (const file of files) {
    // Rollup's virtual modules.
    if (file.startsWith('\0')) continue;
    const root = packageRoot(file);
    if (root) roots.add(root);
  }
  const entries = new Map<string, ThirdPartyLicense>();
  for (const root of roots) {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const name = String(manifest.name);
    const version = String(manifest.version);
    if (entries.has(`${name}@${version}`)) continue;
    const files = readdirSync(root);
    const text = readFirst(root, files, LICENSE_FILE);
    const notice = readFirst(root, files, NOTICE_FILE);
    entries.set(`${name}@${version}`, {
      name,
      version,
      license: licenseOf(manifest.license),
      ...(text && { text }),
      ...(notice && { notice }),
    });
  }
  return mergeLicenses([...entries.values()]);
}

/**
 * The package.json of every package installed in a node_modules folder, pnpm's layout or npm's;
 * workspace packages linked into it are first-party and left out.
 */
export function installedPackages(nodeModules: string): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === '.bin') continue;
      if (name === '.pnpm') {
        for (const id of readdirSync(path)) visit(join(path, id, 'node_modules'));
      } else if (name.startsWith('@')) {
        visit(path);
      } else if (existsSync(join(path, 'package.json'))) {
        if (!realpathSync(path).includes(NODE_MODULES)) continue;
        found.push(join(path, 'package.json'));
        visit(join(path, 'node_modules'));
      }
    }
  };
  visit(resolve(nodeModules));
  return found;
}

/** Licences CycloneDX's Gradle plugin cannot name, by Maven coordinates; checked by hand. */
const MAVEN_LICENSES: Record<string, string> = {
  'io.ionic.libs:ionfilesystem-android': 'MIT',
};

interface MavenComponent {
  group?: string;
  name: string;
  version?: string;
  purl?: string;
  licenses?: { license?: { id?: string; name?: string; url?: string }; expression?: string }[];
}

/** The Android libraries in a CycloneDX SBOM from the Gradle plugin; their AARs carry no texts. */
export function mavenLicenses(bom: { components?: MavenComponent[] }): ThirdPartyLicense[] {
  return mergeLicenses(
    (bom.components ?? [])
      // Gradle projects (`project_path`) are the plugins' npm packages, listed with those.
      .filter(
        (component) =>
          component.purl?.startsWith('pkg:maven/') && !component.purl.includes('project_path='),
      )
      .map((component) => {
        const name = `${component.group ?? ''}:${component.name}`;
        const choices = component.licenses ?? [];
        const ids = choices.map((choice) => choice.expression ?? choice.license?.id);
        // Several licences on one component all apply, as far as anyone can tell.
        const license =
          MAVEN_LICENSES[name] ??
          (ids.length > 0 && ids.every(Boolean) ? ids.join(' AND ') : 'UNKNOWN');
        const url =
          choices.find((choice) => choice.license?.url)?.license?.url ??
          (ids.length === 1 && ids[0] ? `https://spdx.org/licenses/${ids[0]}.html` : undefined);
        return { name, version: component.version ?? '', license, ...(url && { url }) };
      }),
  );
}

/** Builds' entries as one list, by name and version. */
export function mergeLicenses(...lists: ThirdPartyLicense[][]): ThirdPartyLicense[] {
  const entries = new Map(lists.flat().map((entry) => [`${entry.name}@${entry.version}`, entry]));
  return [...entries.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      metafile: { type: 'string', multiple: true, default: [] },
      'node-modules': { type: 'string', multiple: true, default: [] },
    },
  });
  if (!values.out) throw new Error('--out FILE is required');
  const files = [
    ...values.metafile.flatMap((file) =>
      Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { inputs: object }).inputs),
    ),
    ...values['node-modules'].flatMap(installedPackages),
  ];
  writeFileSync(values.out, JSON.stringify(checkLicenses(packageLicenses(files))));
}
