import type { Db } from '../../db/client.ts';
import { deriveKey } from '../crypto.ts';
import { AppPasswordService } from './app-passwords.ts';
import { AuthService } from './auth-service.ts';
import { LoginThrottle } from './login-throttle.ts';
import { SessionService } from './sessions.ts';
import { TwoFactorService } from './two-factor.ts';
import { UserService } from './users.ts';

export function createAuthServices(db: Db, appSecret: string, now: () => Date = () => new Date()) {
  const sessions = new SessionService(db, now);
  const users = new UserService(db, sessions);
  const throttle = new LoginThrottle(db, now);
  const twoFactor = new TwoFactorService(
    db,
    { totp: deriveKey(appSecret, 'totp'), challenge: deriveKey(appSecret, 'login-challenge') },
    now,
  );
  const appPasswords = new AppPasswordService(db, now);
  const auth = new AuthService(users, sessions, throttle, twoFactor, appPasswords);
  return { sessions, users, throttle, twoFactor, appPasswords, auth };
}

export type AuthServices = ReturnType<typeof createAuthServices>;
