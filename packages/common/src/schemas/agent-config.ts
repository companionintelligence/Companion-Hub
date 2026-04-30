import { z } from 'zod';

export const agentOpenApiAuthSchema = z.object({
  type: z.enum(['bearer', 'basic', 'api_key', 'none']).default('none'),
  token_env: z.string().optional(),
  header: z.string().optional(),
  api_key_name: z.string().optional(),
  api_key_in: z.enum(['header', 'query']).optional(),
});

export const agentOpenApiConfigSchema = z.object({
  enabled: z.boolean().default(true),
  spec_path: z.string().default('agents/openapi.yaml'),
  base_url: z.string().optional(),
  auth: agentOpenApiAuthSchema.optional(),
  operations_filter: z.array(z.string()).optional(),
});

export const agentMcpConfigSchema = z.object({
  enabled: z.boolean().default(true),
  transport: z.enum(['sse', 'stdio']).default('sse'),
  url: z.string().optional(),
  command: z.array(z.string()).optional(),
  container: z.string().optional(),
  auth: agentOpenApiAuthSchema.optional(),
});

export const agentSkillConfigSchema = z.union([
  z.boolean(),
  z.object({
    enabled: z.boolean().default(true),
  }),
  z.string(),
]);

export const agentConfigSchema = z
  .object({
    skill: agentSkillConfigSchema.optional(),
    openapi: agentOpenApiConfigSchema.optional(),
    mcp: agentMcpConfigSchema.optional(),
  })
  .optional();

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type AgentOpenApiConfig = z.infer<typeof agentOpenApiConfigSchema>;
export type AgentMcpConfig = z.infer<typeof agentMcpConfigSchema>;
export type AgentOpenApiAuth = z.infer<typeof agentOpenApiAuthSchema>;
export type AgentSkillConfig = z.infer<typeof agentSkillConfigSchema>;
