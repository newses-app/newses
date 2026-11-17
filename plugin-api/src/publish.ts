// Builds @newses/plugin-api to JavaScript in plugin-api/dist, as npm publishes it, versioned from
// PLUGIN_API_VERSION, and shows what would be published; --publish publishes it.
//
//   node plugin-api/src/publish.ts [--publish] [--otp CODE]
import { execFileSync } from 'node:child_process';
import { copyFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PLUGIN_API_VERSION } from './index.ts';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(PACKAGE, 'dist');

/** The workspace's package.json, as far as publishing reads it. */
export interface SourceManifest {
  name: string;
  description?: string;
  license?: string;
  repository?: unknown;
  exports: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * The published package.json: the workspace's, versioned, public, without its scripts and
 * development dependencies, its exports pointing at the built JavaScript and declarations.
 */
export function publishManifest(source: SourceManifest, version: string) {
  const built = (path: string) => path.replace(/^\.\/src\//, './').replace(/\.ts$/, '');
  return {
    name: source.name,
    version,
    description: source.description,
    license: source.license,
    repository: source.repository,
    homepage: 'https://newses.app/guide/plugin-authors',
    type: 'module',
    sideEffects: false,
    engines: { node: '>=24' },
    exports: Object.fromEntries(
      Object.entries(source.exports).map(([entry, path]) => [
        entry,
        { types: `${built(path)}.d.ts`, default: `${built(path)}.js` },
      ]),
    ),
    peerDependencies: source.peerDependencies,
  };
}

/** Declarations import each other by `.js`, as the JavaScript does. */
export const declarationImports = (text: string) =>
  text.replace(/(from\s+['"]\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1.js$2');

const run = (
  command: string,
  args: string[],
  cwd = PACKAGE,
  stderr: 'inherit' | 'pipe' = 'inherit',
) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', stderr] });

/** Whether npm has this version of the package. */
function published(name: string, version: string): boolean {
  try {
    return (
      run('npm', ['view', `${name}@${version}`, 'version'], PACKAGE, 'pipe').trim() === version
    );
  } catch {
    // npm view fails for a package it has never seen.
    return false;
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { publish: { type: 'boolean', default: false }, otp: { type: 'string' } },
  });
  const source = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as SourceManifest;
  const manifest = publishManifest(source, PLUGIN_API_VERSION);

  rmSync(DIST, { recursive: true, force: true });
  run(join(PACKAGE, '..', 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.build.json']);
  for (const file of readdirSync(DIST).filter((name) => name.endsWith('.d.ts'))) {
    const path = join(DIST, file);
    writeFileSync(path, declarationImports(readFileSync(path, 'utf8')));
  }
  writeFileSync(join(DIST, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(join(PACKAGE, 'README.md'), join(DIST, 'README.md'));
  copyFileSync(join(PACKAGE, '..', 'LICENSE'), join(DIST, 'LICENSE'));

  const id = `${manifest.name}@${manifest.version}`;
  // Lists what the package holds.
  execFileSync('npm', ['pack', '--dry-run'], { cwd: DIST, stdio: 'inherit' });
  console.log(`Built ${id} in ${DIST}`);
  if (published(manifest.name, manifest.version)) {
    console.log(`${id} is on npm already: raise PLUGIN_API_VERSION to publish changes.`);
    process.exit(values.publish ? 1 : 0);
  }
  if (!values.publish) {
    console.log(`Not published: rerun with --publish to publish ${id} to npm.`);
    process.exit(0);
  }
  execFileSync(
    'npm',
    ['publish', '--access', 'public', ...(values.otp ? ['--otp', values.otp] : [])],
    { cwd: DIST, stdio: 'inherit' },
  );
  console.log(`Published ${id}.`);
}
