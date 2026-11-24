// Installs a deployment's plugins from npm into a folder of their own, and writes the module that
// lists them, which `#installed-plugins` resolves to in that deployment: through an esbuild alias
// in the Lambda bundles (infra), or `--link` in the Docker image built by compose.plugins.yaml.
//
//   node server/src/plugins/install.ts --dir DIR [--no-audit] [--link] NAME@VERSION|./FILE.tgz...
//
// Install scripts never run. Plugins' peer dependencies (zod, @newses/plugin-api) are left out,
// so a plugin resolves the server's copies from a folder under `server/`. The command also takes
// plugins packed with `npm pack`, as paths inside the folder it runs in, to try them unpublished.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

/** An npm package at an exact version: `name@1.2.3`, `@scope/name@1.2.3-rc.1`. */
const SPEC =
  /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?)$/;

/** Plugins a deployment installs at most. */
export const MAX_PLUGINS = 20;

/** The module, in the plugins' folder, that lists them as `INSTALLED_PLUGINS`. */
export const INSTALLED_MODULE = 'installed.js';
/** What was installed there, so a build can check it is what its config lists. */
const MANIFEST = 'plugins.json';
/** Packages plugins must take from the server, never bring their own of. */
const SHARED_PACKAGES = ['zod', '@newses/plugin-api'];

/** Where `#installed-plugins` points by default: no plugins. */
const DEFAULT_MODULE = fileURLToPath(new URL('installed.ts', import.meta.url));

/** Whether `spec` names an npm package at an exact version. */
export const isPluginSpec = (spec: string) => SPEC.test(spec);

/** Whether `spec` is a plugin packed with `npm pack`: a relative `./…/name.tgz` path. */
export const isPackedSpec = (spec: string) =>
  /^\.\/(?:[\w.-]+\/)*[\w.-]+\.tgz$/.test(spec) && !spec.split('/').includes('..');

/** A plugin to install: its package, as listed, and the packed file it comes from, if any. */
export interface PluginToInstall {
  name: string;
  version: string;
  spec: string;
  /** The absolute path of a packed plugin; null for one from npm. */
  file: string | null;
}

/** The name and version in a packed package's `package/package.json`, read from its tar. */
export function packedManifest(file: string): { name: string; version: string } {
  const tar = gunzipSync(readFileSync(file));
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    const field = (from: number, to: number) =>
      header.subarray(from, to).toString('utf8').replace(/\0.*$/s, '');
    const name = field(0, 100);
    if (!name) break;
    const prefix = field(345, 500);
    const size = Number.parseInt(field(124, 136).trim() || '0', 8);
    if ((prefix ? `${prefix}/${name}` : name) === 'package/package.json') {
      const manifest = JSON.parse(
        tar.subarray(at + 512, at + 512 + size).toString('utf8'),
      ) as Record<string, unknown>;
      if (typeof manifest.name === 'string' && typeof manifest.version === 'string')
        return { name: manifest.name, version: manifest.version };
      break;
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${file} is not a package packed with npm pack`);
}

/** The packages and versions of `specs`; throws on one without an exact version, or a repeat. */
export function parsePluginSpecs(specs: readonly string[]): { name: string; version: string }[] {
  if (specs.length > MAX_PLUGINS) throw new Error(`At most ${String(MAX_PLUGINS)} plugins`);
  const parsed = specs.map((spec) => {
    const match = SPEC.exec(spec);
    if (!match?.[1] || !match[2])
      throw new Error(`${spec} is not a package at an exact version, such as name@1.2.3`);
    return { name: match[1], version: match[2] };
  });
  const names = parsed.map((p) => p.name);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated) throw new Error(`${repeated} is listed more than once`);
  return parsed;
}

/**
 * The plugins `specs` name: npm packages at exact versions, and, with `from`, plugins packed with
 * `npm pack` as `./…/name.tgz` paths inside that folder. Throws on anything else, a missing file,
 * a package listed twice, or too many.
 */
export function pluginsToInstall(specs: readonly string[], from?: string): PluginToInstall[] {
  const plugins = specs.map((spec): PluginToInstall => {
    if (from === undefined || !isPackedSpec(spec)) {
      const [parsed] = parsePluginSpecs([spec]);
      if (!parsed) throw new Error(`${spec} is not a package`);
      return { ...parsed, spec, file: null };
    }
    const file = resolve(from, spec);
    if (!existsSync(file) || !statSync(file).isFile())
      throw new Error(`${spec} was not found in ${from}`);
    const { name, version } = packedManifest(file);
    if (!isPluginSpec(`${name}@${version}`))
      throw new Error(`${spec} holds ${name}@${version}, not an npm package at an exact version`);
    return { name, version, spec, file };
  });
  if (plugins.length > MAX_PLUGINS) throw new Error(`At most ${String(MAX_PLUGINS)} plugins`);
  const names = plugins.map((p) => p.name);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated) throw new Error(`${repeated} is listed more than once`);
  return plugins;
}

/** The module listing the plugins, each package's default export with where it came from. */
export function installedModule(
  plugins: readonly Pick<PluginToInstall, 'name' | 'spec'>[],
): string {
  return [
    '// Generated by server/src/plugins/install.ts: the plugins this deployment installs.',
    ...plugins.map(({ name }, i) => `import plugin${String(i)} from ${JSON.stringify(name)};`),
    '',
    'export const INSTALLED_PLUGINS = [',
    ...plugins.map(
      ({ spec }, i) => `  { source: ${JSON.stringify(spec)}, plugin: plugin${String(i)} },`,
    ),
    '];',
    '',
  ].join('\n');
}

/** The plugins installed in `dir`, as listed; null when none were. */
export function installedSpecs(dir: string): string[] | null {
  const path = join(dir, MANIFEST);
  if (!existsSync(path)) return null;
  return (JSON.parse(readFileSync(path, 'utf8')) as { plugins: string[] }).plugins;
}

export interface InstallOptions {
  dir: string;
  specs: readonly string[];
  /** Fail on high and critical advisories in what is installed. */
  audit: boolean;
  /** Where each package comes from instead of the registry (`file:` for tests). */
  sources?: Readonly<Record<string, string>>;
  /** The folder `./…/name.tgz` specs are in; without it, every spec must be from npm. */
  from?: string;
  /** Runs npm in `dir`; the default runs it with its output on stderr. */
  npm?: (args: string[], dir: string) => void;
}

const runNpm = (args: string[], cwd: string) => {
  execFileSync('npm', args, {
    cwd,
    stdio: ['ignore', process.stderr, 'inherit'],
    env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false' },
  });
};

/**
 * Installs exactly `specs` into `dir`, replacing what was there, without install scripts or peer
 * dependencies; with `audit`, fails on high and critical advisories. Then writes the module
 * listing them and the manifest. Refuses a plugin that brings its own copy of a package the
 * server shares with plugins.
 */
export function installPlugins(options: InstallOptions): void {
  const { dir, specs } = options;
  const npm = options.npm ?? runNpm;
  const plugins = pluginsToInstall(specs, options.from);
  const sourceOf = (plugin: PluginToInstall) =>
    options.sources?.[plugin.name] ?? (plugin.file ? `file:${plugin.file}` : plugin.version);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // A package.json of its own stops npm from resolving the enclosing workspace.
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        // A name and version for npm sbom.
        name: 'newses-plugins',
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies: Object.fromEntries(plugins.map((plugin) => [plugin.name, sourceOf(plugin)])),
      },
      null,
      2,
    )}\n`,
  );
  if (plugins.length > 0) {
    npm(
      [
        'install',
        '--ignore-scripts',
        '--legacy-peer-deps',
        '--omit=dev',
        '--install-links',
        '--no-audit',
      ],
      dir,
    );
    const own = plugins.flatMap(({ name }) =>
      SHARED_PACKAGES.filter(
        (shared) =>
          existsSync(join(dir, 'node_modules', shared, 'package.json')) ||
          existsSync(join(dir, 'node_modules', name, 'node_modules', shared, 'package.json')),
      ).map((shared) => `${name} brings its own ${shared}`),
    );
    if (own.length > 0)
      throw new Error(`${own.join('; ')}: plugins take it as a peer dependency, from the server`);
    if (options.audit) npm(['audit', '--omit=dev', '--audit-level=high'], dir);
  }
  writeFileSync(join(dir, INSTALLED_MODULE), installedModule(plugins));
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify({ plugins: specs }, null, 2)}\n`);
}

/** Points `#installed-plugins` at `dir`'s module, for a Node process run from source. */
export function linkInstalled(dir: string, target: string = DEFAULT_MODULE): void {
  let path = relative(dirname(target), resolve(dir, INSTALLED_MODULE));
  if (!path.startsWith('.')) path = `./${path}`;
  writeFileSync(
    target,
    `// Generated by server/src/plugins/install.ts --link.\nexport { INSTALLED_PLUGINS } from ${JSON.stringify(path)};\n`,
  );
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      'no-audit': { type: 'boolean', default: false },
      link: { type: 'boolean', default: false },
    },
  });
  if (!values.dir) {
    console.error(
      'Usage: node server/src/plugins/install.ts --dir DIR [--no-audit] [--link] NAME@VERSION|./FILE.tgz...',
    );
    process.exit(2);
  }
  try {
    installPlugins({
      dir: values.dir,
      specs: positionals,
      audit: !values['no-audit'],
      from: process.cwd(),
    });
    if (values.link) linkInstalled(values.dir);
    console.error(`Installed ${String(positionals.length)} plugins in ${values.dir}`);
  } catch (err) {
    console.error(`install-plugins: ${(err as Error).message}`);
    process.exit(1);
  }
}
