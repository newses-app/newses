import { DomainError } from '../core/errors.ts';
import { createAuthServices } from '../core/auth/index.ts';
import { createDb } from '../db/client.ts';
import { runCli } from './cli-commands.ts';
import { createRuntime } from './runtime.ts';

async function readStdinLine(): Promise<string> {
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  return input.split(/\r?\n/)[0] ?? '';
}

const { pool } = createRuntime('cli');
let code: number;
try {
  const { users } = createAuthServices(createDb(pool));
  code = await runCli(process.argv.slice(2), users, {
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
