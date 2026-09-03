import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

const getUserConfigSchema = z.object({
  dockerCompose: z.string().nullable(),
  appEnv: z.string().nullable(),
  isEnabled: z.boolean(),
});

const updateUserConfigSchema = z.object({
  dockerCompose: z.string(),
  appEnv: z.string(),
});

export class GetUserConfigDto extends createZodDto(getUserConfigSchema) {}
export class UpdateUserConfigDto extends createZodDto(updateUserConfigSchema) {}
