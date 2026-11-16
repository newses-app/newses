import { randomBytes } from 'node:crypto';
import { emailAddressSchema, loginNameSchema } from '@newses/shared';
import { eq, sql } from 'drizzle-orm';
import { hashPassword } from '../../core/auth/passwords.ts';
import { generatedPasswordExpiry } from '../../core/auth/users.ts';
import { base32Encode } from '../../core/auth/totp.ts';
import { users } from '../../db/schema.ts';
import type { ImportStep } from '../importer.ts';
import { USERS } from '../import-map.ts';

/** TTRSS `access_level` from which a user is an administrator. */
const ADMIN_ACCESS_LEVEL = 10;

/** A password for a new user to sign in with once and change (ADR 0047). */
const temporaryPassword = () =>
  (base32Encode(randomBytes(15)).toLowerCase().match(/.{4}/g) ?? []).join('-');

interface SourceUserRow {
  id: number;
  login: string;
  access_level: number;
  email: string;
}

/**
 * Users: a TTRSS user becomes a new user with a temporary password, or adopts a user here with the
 * same login. Users already imported are left as they are, since their password and role are
 * managed here once they exist. The TTRSS email address waits, unconfirmed, for its owner to send
 * themselves a confirmation link; an adopted user's own address stays.
 */
export const usersStep: ImportStep = {
  name: 'users',
  async run({ source, users: selected, map, report, write, options }) {
    const rows = await source.query<SourceUserRow>(
      'SELECT id, login, access_level, email FROM ttrss_users WHERE id = ANY($1) ORDER BY id',
      [selected.map((u) => u.id)],
    );
    const imported = await map.targets(
      USERS,
      rows.map((r) => r.id),
    );
    for (const row of rows) {
      report.count(row.login, 'users', { source: 1 });
      if (imported.has(row.id)) {
        report.count(row.login, 'users', { imported: 1 });
        continue;
      }
      const login = loginNameSchema.safeParse(row.login);
      if (!login.success) {
        report.skip(
          row.login,
          'users',
          row.id,
          `login not allowed here: ${login.error.issues[0]?.message ?? 'invalid'}`,
        );
        continue;
      }
      const address = row.email.trim();
      const email = emailAddressSchema.safeParse(address);
      if (address && !email.success)
        report.note(row.login, 'users', row.id, `email "${address}" not imported: not an address`);
      const pendingEmail = email.success ? email.data : null;
      await write(async (tx) => {
        const [existing] = await tx
          .select({ id: users.id, email: users.email, pendingEmail: users.pendingEmail })
          .from(users)
          .where(sql`lower(${users.login}) = lower(${login.data})`);
        let userId: number;
        // An adopted user with an address of their own keeps it.
        const takesAddress =
          pendingEmail !== null && (!existing || (!existing.email && !existing.pendingEmail));
        if (existing) {
          userId = existing.id;
          report.note(row.login, 'users', row.id, 'adopted the existing user with this login');
          if (takesAddress)
            await tx.update(users).set({ pendingEmail }).where(eq(users.id, existing.id));
        } else {
          const password = temporaryPassword();
          const expires = generatedPasswordExpiry();
          const [created] = await tx
            .insert(users)
            .values({
              login: login.data,
              passwordHash: await hashPassword(password),
              role: row.access_level >= ADMIN_ACCESS_LEVEL ? 'admin' : 'user',
              passwordChangeRequired: true,
              passwordExpiresAt: expires,
              pendingEmail,
            })
            .returning({ id: users.id });
          if (!created) throw new Error('User insert returned no row');
          userId = created.id;
          report.note(
            row.login,
            'users',
            row.id,
            options.dryRun
              ? 'would get a temporary password'
              : `temporary password ${password} (must be changed at first sign-in; expires ${expires.toISOString().slice(0, 16).replace('T', ' ')} UTC)`,
          );
        }
        if (takesAddress)
          report.note(
            row.login,
            'users',
            row.id,
            `email ${pendingEmail} waits for confirmation in Settings > Account`,
          );
        await map.record(tx, USERS, [{ sourceId: row.id, targetId: userId, userId }]);
      });
      report.count(row.login, 'users', { imported: 1 });
    }
  },
};
