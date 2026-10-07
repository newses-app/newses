import type { LoginThrottle, ThrottleRule } from './login-throttle.ts';
import { verifyAgainstDummy, verifyPassword } from './passwords.ts';
import type { NewSession, SessionKind, SessionService, UserRow } from './sessions.ts';
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

const accountKey = (login: string) => `login:${login.trim().toLowerCase()}`;

export class AuthService {
  readonly #users: UserService;
  readonly #sessions: SessionService;
  readonly #throttle: LoginThrottle;

  constructor(users: UserService, sessions: SessionService, throttle: LoginThrottle) {
    this.#users = users;
    this.#sessions = sessions;
    this.#throttle = throttle;
  }

  async login(input: LoginInput): Promise<NewSession & { user: UserRow }> {
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

    await this.#throttle.reset(account);
    await this.#users.recordLogin(user.id);
    const created = await this.#sessions.create(user.id, input.kind, input.userAgent);
    return { ...created, user };
  }

  async changePassword(
    user: UserRow,
    currentSessionId: number,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    // Shares the login counter, so a stolen session cannot be used to guess the password.
    const account = accountKey(user.login);
    await this.#throttle.check([account]);
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      await this.#throttle.recordFailure(account, ACCOUNT_RULE);
      throw new DomainError('invalid_credentials', 'Current password is incorrect');
    }
    await this.#throttle.reset(account);
    await this.#users.setPassword(user.id, newPassword, currentSessionId);
  }
}
