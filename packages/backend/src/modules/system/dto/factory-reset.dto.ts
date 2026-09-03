import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

export const FACTORY_RESET_CONFIRMATION = 'factory-reset';

const factoryResetBodySchema = z.object({
  confirmation: z.literal(FACTORY_RESET_CONFIRMATION),
});

export class FactoryResetDto extends createZodDto(factoryResetBodySchema) {}
