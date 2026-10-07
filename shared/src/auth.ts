import { z } from 'zod';
import { COMMON_PASSWORDS } from './common-passwords.ts';

export const loginNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\p{L}\p{N}._@-]+$/u, 'Use letters, digits, and . _ @ - only');

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
  createdAt: z.iso.datetime(),
  lastLoginAt: z.iso.datetime().nullable(),
});

export const loginRequestSchema = z.object({
  login: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(1024),
  /** `cookie` for the web app; `bearer` returns a token for desktop and mobile apps. */
  tokenType: z.enum(['cookie', 'bearer']).default('cookie'),
});

export const loginResponseSchema = z.object({
  user: userSchema,
  csrfToken: z.string().optional(),
  token: z.string().optional(),
});

export const currentSessionSchema = z.object({
  user: userSchema,
  csrfToken: z.string().nullable(),
});

export const sessionSchema = z.object({
  id: z.number().int(),
  kind: z.enum(['cookie', 'bearer']),
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
export type CurrentSession = z.infer<typeof currentSessionSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
