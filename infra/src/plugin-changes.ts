// The plugin changes between two deployment configs, per stage, for store-deploy-config.sh:
//
//   node infra/src/plugin-changes.ts STORED_FILE LOCAL_FILE
//
// STORED_FILE may be empty (nothing stored yet).
import { readFileSync } from 'node:fs';

interface ConfigStages {
  stages?: { name: string; plugins?: string[] }[];
}

const byName = (specs: readonly string[]) =>
  new Map(
    specs.map((spec) => {
      const at = spec.lastIndexOf('@');
      return [spec.slice(0, at), spec.slice(at + 1)] as const;
    }),
  );

/** One line per stage whose plugins change: those added, upgraded or downgraded, and removed. */
export function pluginChanges(stored: ConfigStages | null, local: ConfigStages): string[] {
  const names = [
    ...new Set([...(stored?.stages ?? []), ...(local.stages ?? [])].map((s) => s.name)),
  ];
  return names.flatMap((name) => {
    const before = byName(stored?.stages?.find((s) => s.name === name)?.plugins ?? []);
    const after = byName(local.stages?.find((s) => s.name === name)?.plugins ?? []);
    const changes = [
      ...[...after].flatMap(([pkg, version]) => {
        const was = before.get(pkg);
        if (was === undefined) return [`+ ${pkg}@${version}`];
        return was === version ? [] : [`${pkg} ${was} → ${version}`];
      }),
      ...[...before].filter(([pkg]) => !after.has(pkg)).map(([pkg, v]) => `- ${pkg}@${v}`),
    ];
    return changes.length > 0 ? [`${name}: ${changes.join(', ')}`] : [];
  });
}

if (import.meta.main) {
  const [storedFile, localFile] = process.argv.slice(2);
  if (!storedFile || !localFile) {
    console.error('Usage: node infra/src/plugin-changes.ts STORED_FILE LOCAL_FILE');
    process.exit(2);
  }
  const stored = readFileSync(storedFile, 'utf8').trim();
  const lines = pluginChanges(
    stored ? (JSON.parse(stored) as ConfigStages) : null,
    JSON.parse(readFileSync(localFile, 'utf8')) as ConfigStages,
  );
  for (const line of lines) console.log(line);
}
