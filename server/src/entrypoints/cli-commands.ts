import { parseArgs } from 'node:util';
import { passwordSchema, loginNameSchema } from '@rss-reader/shared';
import type { UserService } from '../core/auth/users.ts';

export const USAGE = `Usage:
  cli user create <login> [--admin]    Create a user; password is read from stdin
  cli user reset-password <login>      Set a new password from stdin and sign the user out everywhere`;

export interface CliIo {
  readPassword: () => Promise<string>;
  print: (line: string) => void;
}

/** Runs one CLI command. Returns the process exit code. */
export async function runCli(args: string[], users: UserService, io: CliIo): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { admin: { type: 'boolean', default: false } },
  });
  const [group, command, login] = positionals;
  if (group !== 'user' || !login || (command !== 'create' && command !== 'reset-password')) {
    io.print(USAGE);
    return 2;
  }

  const name = loginNameSchema.safeParse(login);
  if (!name.success) {
    io.print(`Invalid login: ${name.error.issues[0]?.message ?? 'invalid'}`);
    return 1;
  }
  const password = passwordSchema.safeParse(await io.readPassword());
  if (!password.success) {
    io.print('Password must be 8 to 1024 characters');
    return 1;
  }

  if (command === 'create') {
    const user = await users.create(name.data, password.data, values.admin ? 'admin' : 'user');
    io.print(`Created ${user.role} "${user.login}" (id ${String(user.id)})`);
  } else {
    const user = await users.findByLogin(name.data);
    if (!user) {
      io.print(`No user "${name.data}"`);
      return 1;
    }
    await users.setPassword(user.id, password.data);
    io.print(`Password reset for "${user.login}"; existing sessions revoked`);
  }
  return 0;
}
