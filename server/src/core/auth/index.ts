import type { Db } from '../../db/client.ts';
import { AuthService } from './auth-service.ts';
import { LoginThrottle } from './login-throttle.ts';
import { SessionService } from './sessions.ts';
import { UserService } from './users.ts';

export function createAuthServices(db: Db, now: () => Date = () => new Date()) {
  const sessions = new SessionService(db, now);
  const users = new UserService(db, sessions);
  const throttle = new LoginThrottle(db, now);
  const auth = new AuthService(users, sessions, throttle);
  return { sessions, users, throttle, auth };
}

export type AuthServices = ReturnType<typeof createAuthServices>;
