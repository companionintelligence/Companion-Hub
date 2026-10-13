import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

const updateBlocksSchema = z.object({
  /** Why the Hub will refuse a stack update started from Settings, even when a newer release exists. */
  updateBlockedReason: z.string().nullable(),
  /** Why the daily auto-update cannot move this Hub. It never hands the update to the desktop app. */
  autoUpdateBlockedReason: z.string().nullable(),
  /** True when the refusal is because the desktop app on the Hub's computer is what updates it. */
  desktopAppUpdatesHub: z.boolean(),
});

export type UpdateBlocks = z.infer<typeof updateBlocksSchema>;
export class UpdateBlocksDto extends createZodDto(updateBlocksSchema) {}
