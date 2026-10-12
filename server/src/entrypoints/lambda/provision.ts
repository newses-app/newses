import pg from 'pg';

/**
 * Creates a stage's login role and the database it owns on a shared PostgreSQL instance, or
 * brings the role's password up to date. Only the role, its owner, and superusers may connect to
 * the database, so stages cannot reach each other's data. `adminUrl` connects as a user with
 * CREATEROLE and CREATEDB, such as the RDS master user. Safe to repeat.
 */
export async function provisionDatabase(
  adminUrl: string,
  target: { name: string; password: string },
): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const role = client.escapeIdentifier(target.name);
    const password = client.escapeLiteral(target.password);
    const { rowCount: roleExists } = await client.query(
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      [target.name],
    );
    await client.query(
      `${roleExists ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN PASSWORD ${password}`,
    );
    // Creating a database for an owner takes membership in the owner's role; on RDS the master
    // user is no superuser, so it grants that to itself.
    const { rows } = await client.query<{ member: boolean }>(
      "SELECT pg_has_role(current_user, $1, 'SET') AS member",
      [target.name],
    );
    if (!rows[0]?.member) await client.query(`GRANT ${role} TO CURRENT_USER`);
    const { rowCount: databaseExists } = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [target.name],
    );
    if (!databaseExists) await client.query(`CREATE DATABASE ${role} OWNER ${role}`);
    await client.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${role} FROM PUBLIC`);
  } finally {
    await client.end();
  }
}
