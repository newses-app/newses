import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended Argon2id parameters (the library's default algorithm is Argon2id).
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password).catch(() => false);
}

let dummyHash: Promise<string> | undefined;

/** Spends the same time as a real verification, so unknown logins aren't revealed by timing. */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy password for timing');
  await verifyPassword(await dummyHash, password);
}
