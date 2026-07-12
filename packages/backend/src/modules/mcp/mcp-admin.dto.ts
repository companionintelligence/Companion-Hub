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

/** ENH-MCP-4: body for the MCP settings endpoint (currently the destructive-tool gate). */
const mcpAdminSettingsSchema = z.object({
  /** Enable/disable destructive tools over the agent-facing MCP endpoint. */
  allowDestructive: z.boolean(),
});

export class McpAdminSettingsBody extends createZodDto(mcpAdminSettingsSchema) {}

/** SEC-MCP-8: body for creating an operator MCP API key. */
const mcpCreateKeySchema = z.object({
  /** Human-readable label shown in the keys table (e.g. "Laptop CLI", "n8n"). */
  name: z.string().trim().min(1).max(100),
});

export class McpCreateKeyBody extends createZodDto(mcpCreateKeySchema) {}
