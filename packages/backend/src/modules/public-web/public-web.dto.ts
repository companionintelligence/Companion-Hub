import { createZodDto } from '@/common/zod-dto';
import { zodAppUrn } from '@ci-hub/common/types';
import { z } from 'zod';

export const publicWebRepairBodySchema = z.object({
  /** Apps to repair. Omitted or empty, every app the diagnostics report as drifted is repaired. */
  appUrns: z.array(zodAppUrn).optional(),
});

export class PublicWebRepairBody extends createZodDto(publicWebRepairBodySchema) {}
