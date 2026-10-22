import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthServices, type AuthServices } from '../core/auth/index.ts';
import { verifyPassword } from '../core/auth/passwords.ts';
import type { BlobCopyTotals } from '../core/blob-copy.ts';
import { deriveKey, open } from '../core/crypto.ts';
import { DomainError } from '../core/errors.ts';
import { createDb } from '../db/client.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { TEST_APP_SECRET } from '../test/fakes.ts';
import { ImportError } from '../importer/errors.ts';
import type { ImportOptions } from '../importer/importer.ts';
import { ImportReport } from '../importer/report.ts';
import { runCli, USAGE } from './cli-commands.ts';

let database: TestDatabase;
let services: AuthServices;

beforeAll(async () => {
  database = await createTestDatabase();
  services = createAuthServices(createDb(database.pool), TEST_APP_SECRET);
});

afterAll(async () => {
  await database.drop();
});

async function run(args: string[], password = 'a good password') {
  const output: string[] = [];
  const code = await runCli(args, services, {
    readPassword: () => Promise.resolve(password),
    print: (line) => output.push(line),
  });
  return { code, output: output.join('\n') };
}

describe('cli', () => {
  it('creates admins and users', async () => {
    expect(await run(['user', 'create', 'root', '--admin'])).toMatchObject({ code: 0 });
    expect((await services.users.findByLogin('root'))?.role).toBe('admin');
    expect(await run(['user', 'create', 'kid'])).toMatchObject({ code: 0 });
    expect((await services.users.findByLogin('kid'))?.role).toBe('user');
  });

  it('resets passwords', async () => {
    expect(await run(['user', 'reset-password', 'kid'], 'another password')).toMatchObject({
      code: 0,
    });
    const kid = await services.users.findByLogin('kid');
    expect(await verifyPassword(kid?.passwordHash ?? '', 'another password')).toBe(true);
    expect(await run(['user', 'reset-password', 'ghost'])).toMatchObject({ code: 1 });
  });

  it('resets two-factor authentication', async () => {
    const kid = await services.users.findByLogin('kid');
    if (!kid) throw new Error('kid was not created');
    await services.twoFactor.begin(kid);
    expect(await run(['user', 'reset-2fa', 'kid'])).toMatchObject({ code: 0 });
    expect((await services.users.findByLogin('kid'))?.totpSecret).toBeNull();
    expect(await run(['user', 'reset-2fa', 'ghost'])).toMatchObject({ code: 1 });
  });

  it('validates input and prints usage', async () => {
    expect(await run(['user', 'create', 'bad name'])).toMatchObject({ code: 1 });
    expect(await run(['user', 'create', 'shorty'], 'short')).toMatchObject({ code: 1 });
    expect(await run([])).toEqual({ code: 2, output: USAGE });
  });

  it('runs TTRSS imports with their options, printing the report', async () => {
    const calls: [string, ImportOptions][] = [];
    let outcome: () => ImportReport = () => new ImportReport(true);
    const output: string[] = [];
    const importRun = (args: string[]) =>
      runCli(
        ['import-ttrss', ...args],
        {
          ...services,
          importTtrss: (source, options) => {
            calls.push([source, options]);
            return Promise.resolve(outcome());
          },
        },
        { readPassword: () => Promise.resolve(''), print: (line) => output.push(line) },
      );
    const url = 'postgres://u:p@db/ttrss_import';
    expect(
      await importRun([
        '--source',
        url,
        '--users',
        'pat, kid',
        '--since',
        '2025-01-31',
        '--dry-run',
      ]),
    ).toBe(0);
    expect(calls[0]).toEqual([
      url,
      {
        users: ['pat', 'kid'],
        since: new Date('2025-01-31T00:00:00Z'),
        dryRun: true,
        force: false,
      },
    ]);
    expect(output.at(-1)).toContain('TTRSS import report (dry run');
    expect(await importRun(['--users', 'pat'])).toBe(2);
    expect(await importRun(['--source', url, '--since', '31/01/2025'])).toBe(2);
    expect(await importRun(['--source', url, '--bogus'])).toBe(2);
    outcome = () => {
      throw new ImportError('TTRSS schema version 1 is not supported');
    };
    expect(await importRun(['--source', url, '--force'])).toBe(1);
    expect(output.at(-1)).toBe('TTRSS schema version 1 is not supported');
    outcome = () => {
      const report = new ImportReport(false);
      report.count('pat', 'feeds', { source: 1 });
      return report;
    };
    expect(await importRun(['--source', url])).toBe(1);
  });

  it("re-seals two-factor secrets from a previous instance's APP_SECRET", async () => {
    const otherSecret = 'the secret of the instance restored into, 32+ chars';
    const restored = createAuthServices(createDb(database.pool), otherSecret);
    const pat = await services.users.create('pat', 'a good password', 'user');
    const { secret } = await services.twoFactor.begin(pat);
    const sealed = async () => (await services.users.findByLogin('pat'))?.totpSecret ?? '';
    const reseal = (previous: string) =>
      runCli(['reseal-secrets'], restored, {
        readPassword: () => Promise.resolve(previous),
        print: () => undefined,
      });

    expect(await reseal('short')).toBe(2);
    expect(await reseal(TEST_APP_SECRET)).toBe(0);
    const context = `user:${String(pat.id)}:totp`;
    expect(open(deriveKey(otherSecret, 'totp'), await sealed(), context)).toBe(secret);
    // Already under the new secret: the old one no longer opens it, and nothing changes.
    const before = await sealed();
    await expect(reseal(TEST_APP_SECRET)).rejects.toThrow(DomainError);
    expect(await sealed()).toBe(before);
    expect(await reseal(otherSecret)).toBe(0);
    expect(await sealed()).toBe(before);
  });

  it('copies blobs to and from a directory', async () => {
    const calls: [string, string, string][] = [];
    const output: string[] = [];
    const blobs = (args: string[]) =>
      runCli(
        ['blobs', ...args],
        {
          ...services,
          copyBlobs: (direction, dir, prefix, onProgress) => {
            calls.push([direction, dir, prefix]);
            const totals: BlobCopyTotals = { count: 1000, bytes: 2_500_000 };
            onProgress(totals);
            return Promise.resolve(totals);
          },
        },
        { readPassword: () => Promise.resolve(''), print: (line) => output.push(line) },
      );
    expect(await blobs(['pull', '/bundle/blobs'])).toBe(0);
    expect(await blobs(['push', '/bundle/blobs', '--archive-only'])).toBe(0);
    expect(calls).toEqual([
      ['pull', '/bundle/blobs', ''],
      ['push', '/bundle/blobs', 'archive/'],
    ]);
    expect(output).toContain('1000 blobs, 2.5 MB...');
    expect(output.at(-1)).toBe('Copied 1000 blobs, 2.5 MB');
    expect(await blobs(['sideways', '/x'])).toBe(2);
    expect(await blobs(['pull'])).toBe(2);
    expect(await blobs(['pull', '/x', '--bogus'])).toBe(2);
  });
});
