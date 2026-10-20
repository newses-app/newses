import { z } from 'zod';
import { COMMON_PASSWORDS } from './common-passwords.ts';

export const loginNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\p{L}\p{N}._@-]+$/u, 'Use letters, digits, and . _ @ - only');

/**
 * Logins too well known for the first admin: `admin`, `root`, or `superuser` anywhere in them, or
 * `sa` with only digits and separators besides. Other users may still be called anything.
 */
export function isReservedAdminLogin(login: string): boolean {
  const name = login.trim().toLowerCase();
  return (
    ['admin', 'root', 'superuser'].some((part) => name.includes(part)) ||
    name.replace(/[\d._@-]/g, '') === 'sa'
  );
}

export const passwordSchema = z
  .string()
  .min(8)
  .max(1024)
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), 'This password is too common');

export const userRoleSchema = z.enum(['admin', 'user']);

export const userSchema = z.object({
  id: z.number().int(),
  login: z.string(),
  role: userRoleSchema,
  disabled: z.boolean(),
  twoFactor: z.boolean(),
  /** Only changing the password is allowed until it is. */
  passwordChangeRequired: z.boolean(),
  createdAt: z.iso.datetime(),
  lastLoginAt: z.iso.datetime().nullable(),
});

export const loginRequestSchema = z.object({
  login: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(1024),
  /** `cookie` for the web app; `bearer` returns a token for desktop and mobile apps. */
  tokenType: z.enum(['cookie', 'bearer']).default('cookie'),
});

/**
 * Path of the user's feed icons, `/feed-icons/<signed user segment>`: `<path>/<subscription id>.ico`
 * needs no session, so the apps can show icons from another origin.
 */
const iconsPathSchema = z.string();

export const loggedInResponseSchema = z.object({
  user: userSchema,
  csrfToken: z.string().optional(),
  token: z.string().optional(),
  iconsPath: iconsPathSchema,
});

/** The password was right and 2FA is on: send a code with the challenge to `/auth/login/2fa`. */
export const twoFactorChallengeSchema = z.object({
  twoFactorRequired: z.literal(true),
  challenge: z.string(),
});

export const loginResponseSchema = z.union([loggedInResponseSchema, twoFactorChallengeSchema]);

/** A 6-digit authenticator code or a recovery code. */
const secondFactorCodeSchema = z.string().trim().min(6).max(32);

export const loginTwoFactorRequestSchema = z.object({
  challenge: z.string().min(1).max(512),
  code: secondFactorCodeSchema,
});

export const twoFactorStatusSchema = z.object({
  enabled: z.boolean(),
  recoveryCodesLeft: z.number().int(),
});

export const twoFactorSetupRequestSchema = z.object({ password: z.string().min(1).max(1024) });

export const twoFactorSetupResponseSchema = z.object({ secret: z.string(), uri: z.string() });

export const twoFactorCodeRequestSchema = z.object({ code: secondFactorCodeSchema });

export const twoFactorDisableRequestSchema = z.object({
  password: z.string().min(1).max(1024),
  code: secondFactorCodeSchema,
});

export const appPasswordSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});

export const createAppPasswordRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
  /** The account password, re-checked before a lasting credential is issued. */
  password: z.string().min(1).max(1024),
});

/** `password` is shown once; only its hash is stored. */
export const createAppPasswordResponseSchema = z.object({
  appPassword: appPasswordSchema,
  password: z.string(),
});

/** What apps need to connect through the compatibility APIs. */
export const appConnectionSchema = z.object({
  /** Origin of the server, from `PUBLIC_URL` when set. */
  serverUrl: z.string(),
  /** The shortest sync interval apps should be set to. */
  syncIntervalMinutes: z.number().int(),
});

export const recoveryCodesResponseSchema = z.object({ recoveryCodes: z.array(z.string()) });

export const currentSessionSchema = z.object({
  user: userSchema,
  csrfToken: z.string().nullable(),
  iconsPath: iconsPathSchema,
});

export const sessionSchema = z.object({
  id: z.number().int(),
  /** `api`: a compatibility client signed in with an app password. */
  kind: z.enum(['cookie', 'bearer', 'api']),
  userAgent: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  current: z.boolean(),
});

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: passwordSchema,
});

export const createUserRequestSchema = z.object({
  login: loginNameSchema,
  password: passwordSchema,
  role: userRoleSchema.default('user'),
});

export const updateUserRequestSchema = z.object({
  role: userRoleSchema.optional(),
  disabled: z.boolean().optional(),
});

export const resetPasswordRequestSchema = z.object({ password: passwordSchema });

export const errorResponseSchema = z.object({ error: z.string(), message: z.string() });

export type User = z.infer<typeof userSchema>;
export type UserRole = z.infer<typeof userRoleSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type LoggedInResponse = z.infer<typeof loggedInResponseSchema>;
export type TwoFactorChallenge = z.infer<typeof twoFactorChallengeSchema>;
export type TwoFactorStatus = z.infer<typeof twoFactorStatusSchema>;
export type TwoFactorSetup = z.infer<typeof twoFactorSetupResponseSchema>;
export type AppPassword = z.infer<typeof appPasswordSchema>;
export type CreateAppPasswordResponse = z.infer<typeof createAppPasswordResponseSchema>;
export type AppConnection = z.infer<typeof appConnectionSchema>;
export type CurrentSession = z.infer<typeof currentSessionSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
