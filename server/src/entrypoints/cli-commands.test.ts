import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthServices, type AuthServices } from '../core/auth/index.ts';
import { verifyPassword } from '../core/auth/passwords.ts';
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
});
