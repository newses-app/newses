import { describe, expect, it } from 'vitest';
import { isReservedAdminLogin, passwordSchema } from './auth.ts';

describe('passwordSchema', () => {
  it('rejects short and common passwords, case-insensitively', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('password').success).toBe(false);
    expect(passwordSchema.safeParse('Qwerty123').success).toBe(false);
    expect(passwordSchema.safeParse('correct horse battery').success).toBe(true);
  });
});

describe('isReservedAdminLogin', () => {
  it('refuses well-known admin logins and their variants, but not names that contain sa', () => {
    for (const login of [
      'admin',
      'Administrator',
      'admin2',
      'sysadmin',
      'root',
      'root_1',
      'SuperUser',
      'sa',
      'sa2',
      'sa.1',
    ]) {
      expect(isReservedAdminLogin(login), login).toBe(true);
    }
    for (const login of ['pat', 'sarah', 'lisa', 'isaac', 'chris@example.com']) {
      expect(isReservedAdminLogin(login), login).toBe(false);
    }
  });
});
