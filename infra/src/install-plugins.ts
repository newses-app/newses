// Installs each stage's plugins from the deployment config where the functions' bundling finds
// them (plugins.ts), auditing them; the pipelines' synth runs it before `cdk synth`.
//
//   pnpm --filter @newses/infra plugins:install
import { installPlugins } from '@newses/server/install-plugins';
import { STAGES } from './deploy-config.ts';
import { pluginsDir } from './plugins.ts';

for (const stage of STAGES) {
  const specs = stage.plugins ?? [];
  installPlugins({ dir: pluginsDir(stage), specs, audit: true });
  console.log(`${stage.name}: ${specs.length > 0 ? specs.join(', ') : 'no plugins'}`);
}
