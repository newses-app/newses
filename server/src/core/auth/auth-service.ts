import type { AppPasswordRow, AppPasswordService } from './app-passwords.ts';
import type { LoginThrottle, ThrottleRule } from './login-throttle.ts';
import { verifyAgainstDummy, verifyPassword } from './passwords.ts';
import type { NewSession, SessionKind, SessionService, UserRow } from './sessions.ts';
import type { TwoFactorService, TwoFactorSetup } from './two-factor.ts';
import type { UserService } from './users.ts';
import { DomainError } from '../errors.ts';

const ACCOUNT_RULE: ThrottleRule = { threshold: 5 };
// Households share one public IP, so the per-IP allowance is higher.
const IP_RULE: ThrottleRule = { threshold: 20 };

export interface LoginInput {
  login: string;
  password: string;
  kind: SessionKind;
  ip: string;
  userAgent: string | null;
}

export interface SecondFactorInput {
  challenge: string;
  code: string;
  ip: string;
  userAgent: string | null;
}

export interface AppPasswordInput {
  login: string;
  password: string;
  ip: string;
}

export type AppSessionInput = AppPasswordInput & { userAgent: string | null };

export type LoggedIn = NewSession & { user: UserRow };

/** A login either opens a session or, with 2FA on, returns a challenge for the code step. */
export type LoginResult = LoggedIn | { challenge: string; user: UserRow };

/** A generated initial password past its expiry no longer signs in. */
export const passwordExpired = (user: UserRow) =>
  user.passwordExpiresAt !== null && user.passwordExpiresAt <= new Date();

const accountKey = (login: string) => `login:${login.trim().toLowerCase()}`;

export class AuthService {
  readonly #users: UserService;
  readonly #sessions: SessionService;
  readonly #throttle: LoginThrottle;
  readonly #twoFactor: TwoFactorService;
  readonly #appPasswords: AppPasswordService;

  constructor(
    users: UserService,
    sessions: SessionService,
    throttle: LoginThrottle,
    twoFactor: TwoFactorService,
    appPasswords: AppPasswordService,
  ) {
    this.#users = users;
    this.#sessions = sessions;
    this.#throttle = throttle;
    this.#twoFactor = twoFactor;
    this.#appPasswords = appPasswords;
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const account = accountKey(input.login);
    const ipKey = `ip:${input.ip}`;
    await this.#throttle.check([account, ipKey]);

    const user = await this.#users.findByLogin(input.login);
    const valid = user
      ? await verifyPassword(user.passwordHash, input.password)
      : (await verifyAgainstDummy(input.password), false);
    if (!user || !valid || user.disabledAt !== null) {
      await this.#throttle.recordFailure(account, ACCOUNT_RULE);
      await this.#throttle.recordFailure(ipKey, IP_RULE);
      throw new DomainError('invalid_credentials', 'Invalid login or password');
    }
    if (passwordExpired(user)) {
      await this.#throttle.recordFailure(account, ACCOUNT_RULE);
      await this.#throttle.recordFailure(ipKey, IP_RULE);
      throw new DomainError(
        'password_expired',
        'This password has expired; ask an admin for a new one',
      );
    }

    if (user.totpEnabledAt !== null) {
      // The account counter is reset only once the code step succeeds too.
      return {
        challenge: this.#twoFactor.issueChallenge({ userId: user.id, kind: input.kind }),
        user,
      };
    }
    return this.#open(user, input.kind, input.userAgent);
  }

  /** The code step of a login: a TOTP or recovery code against the challenge from `login`. */
  async completeLogin(input: SecondFactorInput): Promise<LoggedIn> {
    const challenge = this.#twoFactor.readChallenge(input.challenge);
    if (!challenge) throw new DomainError('invalid_input', 'Sign-in expired; start again');
    const user = await this.#users.get(challenge.userId);
    const account = accountKey(user.login);
    const ipKey = `ip:${input.ip}`;
    await this.#throttle.check([account, ipKey]);
    if (user.disabledAt !== null || !(await this.#twoFactor.verify(user.id, input.code))) {
      await this.#throttle.recordFailure(account, ACCOUNT_RULE);
      await this.#throttle.recordFailure(ipKey, IP_RULE);
      throw new DomainError('invalid_credentials', 'Invalid code');
    }
    return this.#open(user, challenge.kind, input.userAgent);
  }

  /**
   * Authenticates a compatibility-API client by login and app password, without TOTP. Account
   * passwords are refused, so 2FA cannot be bypassed with them.
   */
  async authenticateAppPassword(input: AppPasswordInput): Promise<UserRow> {
    return (await this.#matchAppPassword(input)).user;
  }

  /**
   * Logs a compatibility client in with an app password, opening an `api` session tied to it,
   * so revoking the app password ends the session.
   */
  async openAppSession(input: AppSessionInput): Promise<LoggedIn> {
    const { user, appPassword } = await this.#matchAppPassword(input);
    await this.#users.recordLogin(user.id);
    const created = await this.#sessions.create(user.id, 'api', input.userAgent, appPassword.id);
    return { ...created, user };
  }

  async #matchAppPassword(
    input: AppPasswordInput,
  ): Promise<{ user: UserRow; appPassword: AppPasswordRow }> {
    const account = accountKey(input.login);
    const ipKey = `ip:${input.ip}`;
    await this.#throttle.check([account, ipKey]);
    const user = await this.#users.findByLogin(input.login);
    const match = user ? await this.#appPasswords.match(user.id, input.password) : null;
    if (!user || !match || user.disabledAt !== null) {
      await this.#throttle.recordFailure(account, ACCOUNT_RULE);
      await this.#throttle.recordFailure(ipKey, IP_RULE);
      throw new DomainError('invalid_credentials', 'Invalid login or app password');
    }
    await this.#throttle.reset(account);
    return { user, appPassword: match };
  }

  /** Re-checks the account password, so a stolen session cannot mint a lasting credential. */
  async createAppPassword(
    user: UserRow,
    password: string,
    name: string,
  ): Promise<{ appPassword: AppPasswordRow; password: string }> {
    await this.#checkPassword(user, password);
    return this.#appPasswords.create(user.id, name);
  }

  /** Admin reset: a new password, every session and app password revoked. */
  async resetPassword(userId: number, password: string): Promise<void> {
    await this.#users.setPassword(userId, password);
    await this.#appPasswords.revokeAll(userId);
  }

  async changePassword(
    user: UserRow,
    currentSessionId: number,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    await this.#checkPassword(user, currentPassword);
    await this.#users.setPassword(user.id, newPassword, currentSessionId);
  }

  /** Starts enrolment after re-checking the password, so a stolen session cannot enrol. */
  async beginTwoFactor(user: UserRow, password: string): Promise<TwoFactorSetup> {
    await this.#checkPassword(user, password);
    return this.#twoFactor.begin(user);
  }

  /** Finishes enrolment, signs out the user's other sessions, and returns recovery codes. */
  async enableTwoFactor(user: UserRow, currentSessionId: number, code: string): Promise<string[]> {
    const account = accountKey(user.login);
    await this.#throttle.check([account]);
    const codes = await this.#twoFactor.enable(user.id, code);
    if (!codes) {
      await this.#throttle.recordFailure(account, ACCOUNT_RULE);
      throw new DomainError('invalid_credentials', 'Invalid code');
    }
    await this.#sessions.revokeAll(user.id, currentSessionId);
    return codes;
  }

  async disableTwoFactor(user: UserRow, password: string, code: string): Promise<void> {
    await this.#checkPassword(user, password);
    await this.#checkCode(user, code);
    await this.#twoFactor.disable(user.id);
  }

  async regenerateRecoveryCodes(user: UserRow, code: string): Promise<string[]> {
    await this.#checkCode(user, code);
    return this.#twoFactor.regenerateRecoveryCodes(user.id);
  }

  /** Admin reset for a user who lost their authenticator: 2FA off and signed out everywhere. */
  async resetTwoFactor(userId: number): Promise<void> {
    await this.#users.get(userId);
    await this.#twoFactor.disable(userId);
    await this.#sessions.revokeAll(userId);
  }

  async #open(user: UserRow, kind: SessionKind, userAgent: string | null): Promise<LoggedIn> {
    await this.#throttle.reset(accountKey(user.login));
    await this.#users.recordLogin(user.id);
    const created = await this.#sessions.create(user.id, kind, userAgent);
    return { ...created, user };
  }

  // Re-authentication shares the login counter, so a stolen session cannot guess credentials.
  async #checkPassword(user: UserRow, password: string): Promise<void> {
    const account = accountKey(user.login);
    await this.#throttle.check([account]);
    if (!(await verifyPassword(user.passwordHash, password))) {
      await this.#throttle.recordFailure(account, ACCOUNT_RULE);
      throw new DomainError('invalid_credentials', 'Current password is incorrect');
    }
    await this.#throttle.reset(account);
  }

  async #checkCode(user: UserRow, code: string): Promise<void> {
    const account = accountKey(user.login);
    await this.#throttle.check([account]);
    if (!(await this.#twoFactor.verify(user.id, code))) {
      await this.#throttle.recordFailure(account, ACCOUNT_RULE);
      throw new DomainError('invalid_credentials', 'Invalid code');
    }
  }
}
