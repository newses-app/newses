import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { runMigrations } from '../../db/migrate.ts';
import { provisionDatabase } from './provision.ts';

const adminUrl = inject('postgresUrl');
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const dev = { name: `rss_reader_dev_${suffix}`, password: 'dev-password' };
const prod = { name: `rss_reader_prod_${suffix}`, password: 'prod-password' };
// Like the RDS master user: no superuser, but CREATEROLE and CREATEDB.
const master = { name: `master_${suffix}`, password: 'master-password' };

/** Connection URL for `database` as `user`. */
const urlFor = (user: string, password: string, database: string) => {
  const url = new URL(adminUrl);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.href;
};

const canConnect = async (url: string) => {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
};

afterAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  for (const { name } of [dev, prod]) {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${name}`);
  }
  await admin.query(`DROP ROLE IF EXISTS ${master.name}`);
  await admin.end();
});

describe('provisionDatabase', () => {
  it('creates a role owning its database, which migrations run as', async () => {
    await provisionDatabase(adminUrl, dev);
    const pool = new pg.Pool({ connectionString: urlFor(dev.name, dev.password, dev.name) });
    try {
      await runMigrations(pool);
      const { rows } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'",
      );
      expect(rows[0]?.n).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });

  it('repeats safely and brings the password up to date', async () => {
    await provisionDatabase(adminUrl, { ...dev, password: 'rotated' });
    expect(await canConnect(urlFor(dev.name, 'rotated', dev.name))).toBe(true);
    expect(await canConnect(urlFor(dev.name, dev.password, dev.name))).toBe(false);
    await provisionDatabase(adminUrl, dev);
    expect(await canConnect(urlFor(dev.name, dev.password, dev.name))).toBe(true);
  });

  it("keeps each stage's role out of the other stage's database, provisioned by a non-superuser", async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(
      `CREATE ROLE ${master.name} LOGIN CREATEROLE CREATEDB PASSWORD '${master.password}'`,
    );
    await admin.end();
    await provisionDatabase(urlFor(master.name, master.password, 'postgres'), prod);
    expect(await canConnect(urlFor(prod.name, prod.password, prod.name))).toBe(true);
    expect(await canConnect(urlFor(dev.name, dev.password, prod.name))).toBe(false);
    expect(await canConnect(urlFor(prod.name, prod.password, dev.name))).toBe(false);
  });
});
