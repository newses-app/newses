import { describe, expect, it } from 'vitest';
import { passwordSchema } from './auth.ts';

describe('passwordSchema', () => {
  it('rejects short and common passwords, case-insensitively', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('password').success).toBe(false);
    expect(passwordSchema.safeParse('Qwerty123').success).toBe(false);
    expect(passwordSchema.safeParse('correct horse battery').success).toBe(true);
  });
});
