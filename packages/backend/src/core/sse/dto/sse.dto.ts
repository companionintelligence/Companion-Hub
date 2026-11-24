import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

/** The most log lines one stream sends back at the start, as the `hub_get_app_logs` MCP tool caps them. */
export const MAX_LOG_STREAM_LINES = 1000;

/** Lines a log stream starts with when the request names no number. */
const DEFAULT_LOG_STREAM_LINES = 300;

const maxLinesSchema = z.union([z.number().int(), z.string().transform(Number)]).pipe(z.number().int().min(1));

const streamAppQuerySchema = z.object({
  appUrn: z.string(),
  maxLines: maxLinesSchema.optional(),
});

const streamHubQuerySchema = z.object({
  maxLines: maxLinesSchema.optional(),
});

export class StreamAppLogsQueryDto extends createZodDto(streamAppQuerySchema) {}
export class StreamHubLogsQueryDto extends createZodDto(streamHubQuerySchema) {}

/**
 * The lines a stream starts with: what was asked for, cut to {@link MAX_LOG_STREAM_LINES}. A larger
 * request is cut rather than refused, so a Logs tab that asks for more still opens.
 */
export function logStreamLines(requested: number | undefined): number {
  return Math.min(requested ?? DEFAULT_LOG_STREAM_LINES, MAX_LOG_STREAM_LINES);
}
