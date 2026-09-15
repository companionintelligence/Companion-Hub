import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

export const userSchema = z.object({
  id: z.number().int(),
  username: z.string().trim(),
  totpEnabled: z.boolean(),
  locale: z.string().trim(),
  operator: z.boolean(),
  hasCompletedOnboarding: z.boolean(),
  advancedMode: z.boolean(),
  accessStatus: z.enum(['active', 'revoked']).optional(),
  orgRole: z.enum(['owner', 'admin', 'member']).nullable().optional(),
});

export class UserDto extends createZodDto(userSchema) {}
