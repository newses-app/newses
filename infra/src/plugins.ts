import { join } from 'node:path';
import { INSTALLED_MODULE, installedSpecs } from '@newses/server/install-plugins';
import { REPO_ROOT, type StageConfig } from './config.ts';

/**
 * Where `plugins:install` installs a stage's plugins: under `server/`, so they resolve the
 * server's zod and plugin contract when bundled.
 */
export const pluginsDir = (stage: StageConfig) => join(REPO_ROOT, 'server', '.plugins', stage.name);

/**
 * The esbuild aliases that bundle the stage's plugins into a function: `#installed-plugins` to
 * the list `plugins:install` wrote. None for a stage without plugins; throws when what is
 * installed is not what the stage lists.
 */
export function pluginAliases(
  stage: StageConfig,
  dir: string = pluginsDir(stage),
): Record<string, string> {
  const specs = stage.plugins ?? [];
  if (specs.length === 0) return {};
  const installed = installedSpecs(dir);
  if (installed?.join(' ') !== specs.join(' ')) {
    throw new Error(
      `The ${stage.name} stage's plugins are not installed as its deployment config lists them: ` +
        'run pnpm --filter @newses/infra plugins:install',
    );
  }
  return { '#installed-plugins': join(dir, INSTALLED_MODULE) };
}
