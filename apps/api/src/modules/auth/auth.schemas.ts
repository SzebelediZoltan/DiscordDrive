import { z } from 'zod'

/**
 * Password policy. Length is the dominant factor in offline-cracking resistance, so the
 * minimum is 10 characters and the extra rules are composition, not length.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password must be at most 200 characters')
  .refine((v) => /[a-z]/.test(v), 'Password must contain a lowercase letter')
  .refine((v) => /[A-Z]/.test(v), 'Password must contain an uppercase letter')
  .refine((v) => /[0-9]/.test(v), 'Password must contain a digit')

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(254, 'Email address is too long')

export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: z.string().trim().min(1, 'Display name is required').max(64).optional(),
  })
  .strict()

export const loginSchema = z
  .object({
    email: emailSchema,
    // Deliberately not `passwordSchema`: an old account may predate the policy, and
    // rejecting it at login would lock that user out with no way to recover.
    password: z.string().min(1, 'Password is required').max(200),
  })
  .strict()

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: passwordSchema,
  })
  .strict()

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>