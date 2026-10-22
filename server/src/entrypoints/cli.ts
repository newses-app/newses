import { LocalBlobStore } from '../adapters/local-blob-store.ts';
import { createAuthServices } from '../core/auth/index.ts';
import { copyBlobs } from '../core/blob-copy.ts';
import { DomainError } from '../core/errors.ts';
import { createDb } from '../db/client.ts';
import { importTtrss } from '../importer/importer.ts';
import { TtrssSource } from '../importer/source.ts';
import { IMPORT_STEPS } from '../importer/steps.ts';
import { runCli } from './cli-commands.ts';
import { createArchiveWriter, createBlobStore } from './feed-deps.ts';
import { createRuntime } from './runtime.ts';

async function readStdinLine(): Promise<string> {
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  return input.split(/\r?\n/)[0] ?? '';
}

const { config, pool } = createRuntime('cli');
const db = createDb(pool);
let code: number;
try {
  const services = {
    ...createAuthServices(db, config.appSecret),
    async importTtrss(url: string, options: Parameters<typeof importTtrss>[1]) {
      const source = await TtrssSource.open(url);
      try {
        return await importTtrss(
          {
            db,
            source,
            steps: IMPORT_STEPS,
            purgeDays: config.feeds.purgeDays,
            archive: createArchiveWriter(config, createBlobStore(config)),
          },
          options,
        );
      } finally {
        await source.close();
      }
    },
    copyBlobs(
      direction: 'pull' | 'push',
      dir: string,
      prefix: string,
      onProgress: Parameters<typeof copyBlobs>[3],
    ) {
      const [store, local] = [createBlobStore(config), new LocalBlobStore(dir)];
      return direction === 'pull'
        ? copyBlobs(store, local, prefix, onProgress)
        : copyBlobs(local, store, prefix, onProgress);
    },
  };
  code = await runCli(process.argv.slice(2), services, {
    readPassword: readStdinLine,
    print: (line) => {
      console.log(line);
    },
  });
} catch (err) {
  if (!(err instanceof DomainError)) throw err;
  console.error(err.message);
  code = 1;
} finally {
  await pool.end();
}
process.exitCode = code;
