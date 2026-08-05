import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

const mcpInstallSchemaField = z.object({
  key: z.string(),
  label: z.string(),
  hint: z.string().optional(),
  required: z.boolean(),
  secret: z.boolean(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  source: z.enum(['form_field', 'mcp_env']),
});

export const mcpInstallSchemaDto = z.object({
  transport: z.enum(['stdio', 'http']).optional(),
  requires: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()),
  fields: z.array(mcpInstallSchemaField),
  toolCount: z.number(),
  bridgeable: z.boolean(),
  bridgeWarning: z.string().optional(),
});

export const mcpProbeResultDto = z.object({
  bridgeable: z.boolean(),
  transport: z.string().optional(),
  containerStatus: z.enum(['running', 'stopped', 'missing', 'unknown']),
  toolCount: z.number(),
  lastError: z.string().optional(),
  lastProbeAt: z.string().optional(),
  bridgeWarning: z.string().optional(),
  connected: z.boolean(),
});

export const validateConfigResultDto = z.object({
  valid: z.boolean(),
  errors: z.array(
    z.object({
      env_variable: z.string(),
      label: z.string(),
      messageKey: z.string(),
    }),
  ),
});

export class McpInstallSchemaDto extends createZodDto(mcpInstallSchemaDto) {}
export class McpProbeResultDto extends createZodDto(mcpProbeResultDto) {}
export class ValidateConfigResultDto extends createZodDto(validateConfigResultDto) {}
