import { isReservedAdminLogin } from '@newses/shared';
import { and, asc, count, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { users } from '../../db/schema.ts';
import { isUniqueViolation } from '../db-errors.ts';
import { DomainError } from '../errors.ts';
import { hashPassword } from './passwords.ts';
import type { SessionService, UserRow } from './sessions.ts';

export type UserRole = 'admin' | 'user';

/** Days a generated initial password signs in for, unless changed. */
export const GENERATED_PASSWORD_DAYS = 7;

/** When a generated password set now expires. */
export const generatedPasswordExpiry = () =>
  new Date(Date.now() + GENERATED_PASSWORD_DAYS * 24 * 60 * 60 * 1000);

export interface UserChanges {
  role?: UserRole;
  disabled?: boolean;
}

export class UserService {
  readonly #db: Db;
  readonly #sessions: SessionService;

  constructor(db: Db, sessions: SessionService) {
    this.#db = db;
    this.#sessions = sessions;
  }

  list(): Promise<UserRow[]> {
    return this.#db.select().from(users).orderBy(asc(users.login));
  }

  async get(id: number): Promise<UserRow> {
    const [user] = await this.#db.select().from(users).where(eq(users.id, id));
    if (!user) throw new DomainError('not_found', 'User not found');
    return user;
  }

  async findByLogin(login: string): Promise<UserRow | undefined> {
    const [user] = await this.#db
      .select()
      .from(users)
      .where(eq(sql`lower(${users.login})`, login.trim().toLowerCase()));
    return user;
  }

  async create(
    login: string,
    password: string,
    role: UserRole = 'user',
    generated = false,
  ): Promise<UserRow> {
    const passwordHash = await hashPassword(password);
    try {
      const [user] = await this.#db
        .insert(users)
        .values({
          login,
          passwordHash,
          role,
          passwordChangeRequired: generated,
          passwordExpiresAt: generated ? generatedPasswordExpiry() : null,
        })
        .returning();
      if (!user) throw new Error('User insert returned no row');
      return user;
    } catch (err) {
      if (isUniqueViolation(err)) throw new DomainError('conflict', `Login "${login}" is taken`);
      throw err;
    }
  }

  /**
   * Creates the first admin when the database has no users. Returns whether it did. A
   * `generated` password must be changed at first sign-in, and expires. Well-known logins are
   * refused (`isReservedAdminLogin`).
   */
  async bootstrapAdmin(login: string, password: string, generated = false): Promise<boolean> {
    const [row] = await this.#db.select({ n: count() }).from(users);
    if (row && row.n > 0) return false;
    if (isReservedAdminLogin(login)) {
      throw new DomainError(
        'invalid_input',
        `"${login}" is too well known for the first admin's login; choose another`,
      );
    }
    try {
      await this.create(login, password, 'admin', generated);
      return true;
    } catch (err) {
      // Another instance bootstrapped concurrently.
      if (err instanceof DomainError && err.code === 'conflict') return false;
      throw err;
    }
  }

  async update(id: number, changes: UserChanges): Promise<UserRow> {
    const user = await this.#db.transaction(async (tx) => {
      const [current] = await tx.select().from(users).where(eq(users.id, id)).for('update');
      if (!current) throw new DomainError('not_found', 'User not found');
      const losesAdmin =
        current.role === 'admin' &&
        current.disabledAt === null &&
        (changes.role === 'user' || changes.disabled === true);
      if (losesAdmin) await assertAnotherActiveAdmin(tx, id);
      const [updated] = await tx
        .update(users)
        .set({
          ...(changes.role && { role: changes.role }),
          ...(changes.disabled !== undefined && {
            disabledAt: changes.disabled ? (current.disabledAt ?? new Date()) : null,
          }),
        })
        .where(eq(users.id, id))
        .returning();
      if (!updated) throw new DomainError('not_found', 'User not found');
      return updated;
    });
    if (changes.disabled) await this.#sessions.revokeAll(id);
    return user;
  }

  async delete(id: number): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const [current] = await tx.select().from(users).where(eq(users.id, id)).for('update');
      if (!current) throw new DomainError('not_found', 'User not found');
      if (current.role === 'admin' && current.disabledAt === null) {
        await assertAnotherActiveAdmin(tx, id);
      }
      await tx.delete(users).where(eq(users.id, id));
    });
  }

  /** Sets a new password and revokes sessions, keeping `keepSessionId` (the caller's own). */
  async setPassword(id: number, password: string, keepSessionId?: number): Promise<void> {
    const passwordHash = await hashPassword(password);
    const updated = await this.#db
      .update(users)
      .set({ passwordHash, passwordChangeRequired: false, passwordExpiresAt: null })
      .where(eq(users.id, id))
      .returning({ id: users.id });
    if (updated.length === 0) throw new DomainError('not_found', 'User not found');
    await this.#sessions.revokeAll(id, keepSessionId);
  }

  /** Logins of enabled admins too well known to keep (`isReservedAdminLogin`). */
  async reservedAdminLogins(): Promise<string[]> {
    const admins = await this.#db
      .select({ login: users.login })
      .from(users)
      .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)));
    return admins.map((admin) => admin.login).filter(isReservedAdminLogin);
  }

  /**
   * Gives the first admin a new generated password, for a stage whose only way in is that admin's
   * expired one. Refused while another active admin exists, who can reset it instead.
   */
  async reissueAdmin(login: string, password: string): Promise<void> {
    const passwordHash = await hashPassword(password);
    const id = await this.#db.transaction(async (tx) => {
      const [admin] = await tx
        .select()
        .from(users)
        .where(
          and(eq(sql`lower(${users.login})`, login.trim().toLowerCase()), eq(users.role, 'admin')),
        )
        .for('update');
      if (!admin) throw new DomainError('not_found', `No admin "${login}"`);
      const others = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'admin'), isNull(users.disabledAt), ne(users.id, admin.id)));
      if (others.length > 0) {
        throw new DomainError('conflict', 'Another active admin can reset this password');
      }
      await tx
        .update(users)
        .set({
          passwordHash,
          passwordChangeRequired: true,
          passwordExpiresAt: generatedPasswordExpiry(),
          disabledAt: null,
        })
        .where(eq(users.id, admin.id));
      return admin.id;
    });
    await this.#sessions.revokeAll(id);
  }

  async recordLogin(id: number): Promise<void> {
    await this.#db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id));
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function assertAnotherActiveAdmin(tx: Tx, excludingId: number): Promise<void> {
  const others = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), isNull(users.disabledAt), ne(users.id, excludingId)))
    .for('update');
  if (others.length === 0) {
    throw new DomainError('last_admin', 'At least one active admin must remain');
  }
}
