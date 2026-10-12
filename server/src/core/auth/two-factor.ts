import { randomBytes } from 'node:crypto';
import { and, count, eq, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { recoveryCodes, users } from '../../db/schema.ts';
import { open, seal, sign, verify } from '../crypto.ts';
import { DomainError } from '../errors.ts';
import type { SessionKind, UserRow } from './sessions.ts';
import { hashToken } from './tokens.ts';
import { base32Decode, base32Encode, matchTotp, newTotpSecret, otpauthUri } from './totp.ts';

const ISSUER = 'Newses';
const RECOVERY_CODE_COUNT = 10;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface TwoFactorKeys {
  /** Seals TOTP secrets. */
  totp: Buffer;
  /** Signs the challenge between the password and code steps of a login. */
  challenge: Buffer;
}

export interface TwoFactorSetup {
  /** Base32, for typing into an authenticator app. */
  secret: string;
  uri: string;
}

export interface LoginChallenge {
  userId: number;
  kind: SessionKind;
}

const secretContext = (userId: number) => `user:${String(userId)}:totp`;
const normalizeRecoveryCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** 80-bit codes shown as `XXXX-XXXX-XXXX-XXXX`. */
function newRecoveryCode(): string {
  return (base32Encode(randomBytes(10)).match(/.{4}/g) ?? []).join('-');
}

/** TOTP enrolment, verification with replay protection, recovery codes, and login challenges. */
export class TwoFactorService {
  readonly #db: Db;
  readonly #keys: TwoFactorKeys;
  readonly #now: () => Date;

  constructor(db: Db, keys: TwoFactorKeys, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#keys = keys;
    this.#now = now;
  }

  /** Stores a new pending secret; enrolment completes with `enable`. */
  async begin(user: UserRow): Promise<TwoFactorSetup> {
    const secret = newTotpSecret();
    const updated = await this.#db
      .update(users)
      .set({
        totpSecret: seal(this.#keys.totp, base32Encode(secret), secretContext(user.id)),
        totpLastStep: null,
      })
      .where(and(eq(users.id, user.id), isNull(users.totpEnabledAt)))
      .returning({ id: users.id });
    if (updated.length === 0) {
      throw new DomainError('conflict', 'Two-factor authentication is already on');
    }
    return { secret: base32Encode(secret), uri: otpauthUri(secret, user.login, ISSUER) };
  }

  /** Turns 2FA on once a code from the pending secret checks out; returns new recovery codes. */
  async enable(userId: number, code: string): Promise<string[] | null> {
    const user = await this.#user(userId);
    if (user.totpEnabledAt !== null || user.totpSecret === null) {
      throw new DomainError('conflict', 'Start two-factor setup first');
    }
    const step = matchTotp(this.#secret(user), code.replace(/\s/g, ''), this.#now(), null);
    if (step === null) return null;
    const enabled = await this.#db
      .update(users)
      .set({ totpEnabledAt: this.#now(), totpLastStep: step })
      .where(and(eq(users.id, userId), isNull(users.totpEnabledAt)))
      .returning({ id: users.id });
    if (enabled.length === 0) throw new DomainError('conflict', 'Start two-factor setup first');
    return this.regenerateRecoveryCodes(userId);
  }

  /**
   * Checks a TOTP code or an unused recovery code, consuming it. Codes from a time step at or
   * before the last accepted one are refused.
   */
  async verify(userId: number, code: string): Promise<boolean> {
    const user = await this.#user(userId);
    if (user.totpEnabledAt === null) return false;
    const compact = code.replace(/\s/g, '');
    if (/^\d{6}$/.test(compact)) {
      const step = matchTotp(this.#secret(user), compact, this.#now(), user.totpLastStep);
      if (step === null) return false;
      const accepted = await this.#db
        .update(users)
        .set({ totpLastStep: step })
        .where(
          and(eq(users.id, userId), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))),
        )
        .returning({ id: users.id });
      return accepted.length > 0;
    }
    const used = await this.#db
      .update(recoveryCodes)
      .set({ usedAt: this.#now() })
      .where(
        and(
          eq(recoveryCodes.userId, userId),
          eq(recoveryCodes.codeHash, hashToken(normalizeRecoveryCode(compact))),
          isNull(recoveryCodes.usedAt),
        ),
      )
      .returning({ id: recoveryCodes.id });
    return used.length > 0;
  }

  /** Replaces every recovery code of the user. */
  async regenerateRecoveryCodes(userId: number): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    await this.#db.transaction(async (tx) => {
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
      await tx
        .insert(recoveryCodes)
        .values(
          codes.map((code) => ({ userId, codeHash: hashToken(normalizeRecoveryCode(code)) })),
        );
    });
    return codes;
  }

  async recoveryCodesLeft(userId: number): Promise<number> {
    const [row] = await this.#db
      .select({ n: count() })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
    return row?.n ?? 0;
  }

  /** Removes the secret and recovery codes, whether enrolment finished or not. */
  async disable(userId: number): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null })
        .where(eq(users.id, userId));
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    });
  }

  /** A signed, short-lived token proving the password step of a login succeeded. */
  issueChallenge(challenge: LoginChallenge): string {
    const expiresAt = this.#now().getTime() + CHALLENGE_TTL_MS;
    const payload = Buffer.from(
      JSON.stringify({ u: challenge.userId, k: challenge.kind, e: expiresAt }),
    ).toString('base64url');
    return `${payload}.${sign(this.#keys.challenge, payload)}`;
  }

  /** The challenge's login, or null when it is forged, malformed, or expired. */
  readChallenge(token: string): LoginChallenge | null {
    const [payload, mac, ...rest] = token.split('.');
    if (!payload || !mac || rest.length > 0 || !verify(this.#keys.challenge, payload, mac)) {
      return null;
    }
    const { u, k, e } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      u: number;
      k: SessionKind;
      e: number;
    };
    return e > this.#now().getTime() ? { userId: u, kind: k } : null;
  }

  async #user(userId: number): Promise<UserRow> {
    const [user] = await this.#db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new DomainError('not_found', 'User not found');
    return user;
  }

  #secret(user: UserRow): Buffer {
    if (user.totpSecret === null) throw new Error('User has no TOTP secret');
    return base32Decode(open(this.#keys.totp, user.totpSecret, secretContext(user.id)));
  }
}
