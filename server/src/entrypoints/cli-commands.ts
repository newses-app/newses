import { parseArgs } from 'node:util';
import { passwordSchema, loginNameSchema } from '@newses/shared';
import type { AuthServices } from '../core/auth/index.ts';
import type { BlobCopyTotals } from '../core/blob-copy.ts';
import { deriveKey } from '../core/crypto.ts';
import { ImportError } from '../importer/errors.ts';
import type { ImportOptions } from '../importer/importer.ts';
import type { ImportReport } from '../importer/report.ts';

export const USAGE = `Usage:
  cli user create <login> [--admin]    Create a user; password is read from stdin
  cli user reset-password <login>      Set a new password from stdin; revokes sessions and app passwords
  cli user reset-2fa <login>           Turn off two-factor authentication and sign the user out everywhere
  cli import-ttrss --source <postgres-url> [--users a,b] [--since YYYY-MM-DD] [--dry-run] [--force]
                                       Import TTRSS users' data; see https://newses.app/guide/migration-ttrss
  cli blobs pull|push <dir> [--archive-only]
                                       Copy the blob store to (pull) or from (push) a local directory
  cli reseal-secrets                   Re-seal two-factor secrets sealed under the previous instance's
                                       APP_SECRET, read from stdin, with this one`;

const COMMANDS = new Set(['create', 'reset-password', 'reset-2fa']);

export type CliDeps = Pick<AuthServices, 'users' | 'auth' | 'twoFactor'> & {
  /** Imports from the TTRSS database at `source`. */
  importTtrss?: (source: string, options: ImportOptions) => Promise<ImportReport>;
  /** Copies the blobs under `prefix` between the blob store and the directory `dir`. */
  copyBlobs?: (
    direction: 'pull' | 'push',
    dir: string,
    prefix: string,
    onProgress: (totals: BlobCopyTotals) => void,
  ) => Promise<BlobCopyTotals>;
};

export interface CliIo {
  /** The first line of stdin. */
  readPassword: () => Promise<string>;
  print: (line: string) => void;
}

/** Runs one CLI command. Returns the process exit code. */
export async function runCli(
  args: string[],
  { users, auth, twoFactor, importTtrss, copyBlobs }: CliDeps,
  io: CliIo,
): Promise<number> {
  if (args[0] === 'import-ttrss' && importTtrss) return runImport(args.slice(1), importTtrss, io);
  if (args[0] === 'blobs' && copyBlobs) return runBlobCopy(args.slice(1), copyBlobs, io);
  if (args[0] === 'reseal-secrets' && args.length === 1) {
    const previous = await io.readPassword();
    if (previous.length < 32) {
      io.print("The previous instance's APP_SECRET (at least 32 characters) is read from stdin");
      return 2;
    }
    const count = await twoFactor.reseal(deriveKey(previous, 'totp'));
    io.print(`Re-sealed ${String(count)} two-factor secrets`);
    return 0;
  }
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { admin: { type: 'boolean', default: false } },
  });
  const [group, command, login] = positionals;
  if (group !== 'user' || !login || !command || !COMMANDS.has(command)) {
    io.print(USAGE);
    return 2;
  }

  const name = loginNameSchema.safeParse(login);
  if (!name.success) {
    io.print(`Invalid login: ${name.error.issues[0]?.message ?? 'invalid'}`);
    return 1;
  }
  if (command === 'reset-2fa') {
    const user = await users.findByLogin(name.data);
    if (!user) {
      io.print(`No user "${name.data}"`);
      return 1;
    }
    await auth.resetTwoFactor(user.id);
    io.print(`Two-factor authentication off for "${user.login}"; existing sessions revoked`);
    return 0;
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
    await auth.resetPassword(user.id, password.data);
    io.print(`Password reset for "${user.login}"; sessions and app passwords revoked`);
  }
  return 0;
}

async function runBlobCopy(
  args: string[],
  copyBlobs: NonNullable<CliDeps['copyBlobs']>,
  io: CliIo,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: { 'archive-only': { type: 'boolean', default: false } },
    });
  } catch (err) {
    io.print(err instanceof Error ? err.message : String(err));
    io.print(USAGE);
    return 2;
  }
  const [direction, dir, ...rest] = parsed.positionals;
  if ((direction !== 'pull' && direction !== 'push') || !dir || rest.length > 0) {
    io.print(USAGE);
    return 2;
  }
  const megabytes = (bytes: number) => (bytes / 1e6).toFixed(1);
  const totals = await copyBlobs(
    direction,
    dir,
    parsed.values['archive-only'] ? 'archive/' : '',
    ({ count, bytes }) => {
      if (count % 1000 === 0) io.print(`${String(count)} blobs, ${megabytes(bytes)} MB...`);
    },
  );
  io.print(`Copied ${String(totals.count)} blobs, ${megabytes(totals.bytes)} MB`);
  return 0;
}

async function runImport(
  args: string[],
  importTtrss: NonNullable<CliDeps['importTtrss']>,
  io: CliIo,
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        source: { type: 'string' },
        users: { type: 'string' },
        since: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    io.print(err instanceof Error ? err.message : String(err));
    io.print(USAGE);
    return 2;
  }
  if (!values.source) {
    io.print('--source is required');
    io.print(USAGE);
    return 2;
  }
  let since: Date | undefined;
  if (values.since !== undefined) {
    since = new Date(`${values.since}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.since) || Number.isNaN(since.getTime())) {
      io.print('--since must be a date, YYYY-MM-DD');
      return 2;
    }
  }
  const users = values.users
    ?.split(',')
    .map((login) => login.trim())
    .filter(Boolean);
  try {
    const report = await importTtrss(values.source, {
      users,
      since,
      dryRun: values['dry-run'],
      force: values.force,
    });
    io.print(report.format());
    return report.reconciled ? 0 : 1;
  } catch (err) {
    if (!(err instanceof ImportError)) throw err;
    io.print(err.message);
    return 1;
  }
}
