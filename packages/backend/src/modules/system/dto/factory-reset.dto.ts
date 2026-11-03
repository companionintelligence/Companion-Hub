import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

const factoryResetBodySchema = z.object({
  confirmation: z.string().trim().min(1),
  /**
   * Also release every app Companion Portal lists for this device before the reset drops the device
   * key. Off when absent, so a caller that predates it keeps the apps listed for the next pairing to
   * restore.
   */
  removeAppsFromPortal: z.boolean().optional(),
});

export class FactoryResetDto extends createZodDto(factoryResetBodySchema) {}
