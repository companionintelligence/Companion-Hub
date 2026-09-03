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
});

export class UserDto extends createZodDto(userSchema) {}
