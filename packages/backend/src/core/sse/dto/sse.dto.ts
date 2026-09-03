import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

const streamAppQuerySchema = z.object({
  appUrn: z.string(),
  maxLines: z.union([z.number().int(), z.string().transform(Number)]).optional(),
});

const streamHubQuerySchema = z.object({
  maxLines: z.union([z.number().int(), z.string().transform(Number)]).optional(),
});

export class StreamAppLogsQueryDto extends createZodDto(streamAppQuerySchema) {}
export class StreamHubLogsQueryDto extends createZodDto(streamHubQuerySchema) {}
