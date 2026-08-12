import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

/** ENH-MCP-4: body for the operator tool runner — arbitrary tool arguments + a destructive confirm. */
const mcpToolCallSchema = z.object({
  /** Arguments passed to the tool, matching its inputSchema. */
  arguments: z.record(z.string(), z.unknown()).optional(),
  /** Operator confirmation required to run a destructive tool from the UI (ISSUE-MCP-2). */
  confirmDestructive: z.boolean().optional(),
});

export class McpToolCallBody extends createZodDto(mcpToolCallSchema) {}
