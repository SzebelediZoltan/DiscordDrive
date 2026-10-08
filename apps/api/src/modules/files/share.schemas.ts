import { z } from 'zod'

/**
 * Bodies for the share dialog. The mode decides which field matters: SPECIFIC requires a
 * non-empty list of recipient emails, LINK and RESTRICTED ignore whatever list the client
 * sends, because the server's transition logic (clear grants / clear token) owns those.
 */
export const updateShareSchema = z.object({
  mode: z.enum(['RESTRICTED', 'LINK', 'SPECIFIC']),
  emails: z.array(z.string().trim().email().max(255)).max(100).optional(),
})

export const shareTokenSchema = z.string().min(16).max(128)