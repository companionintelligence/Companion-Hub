import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

const factoryResetBodySchema = z.object({
  confirmation: z.string().trim().min(1),
});

export class FactoryResetDto extends createZodDto(factoryResetBodySchema) {}
