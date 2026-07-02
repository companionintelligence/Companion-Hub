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

/**
 * Per-intent privacy + safety label, mirroring CI-Server's `IntentPrivacy`. Lets a
 * dispatcher gate destructive/external actions an app contributes.
 */
export const agentIntentPrivacySchema = z.object({
  access: z.enum(['read', 'write', 'delete']).default('read'),
  sensitivity: z.enum(['low', 'personal', 'sensitive']).default('personal'),
  destructive: z.boolean().default(false),
  external: z.boolean().default(false),
});

/**
 * A typed semantic action an app contributes to the CI Intent catalog. Installing
 * an app that declares intents EXPANDS the agent's vocabulary — the assistant gains
 * new capabilities when you install the app. `name` is the dotted
 * `<domain>.<action>` id (manifests use a single domain segment; Hub sync may
 * rewrite to a dotted namespaced path like `app.<slug>.<domain>.<action>`);
 * `parameters` is a JSON Schema object.
 */
export const agentIntentSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*\.[a-zA-Z][a-zA-Z0-9]*$/,
      'intent name must be "<domain>.<action>" (domain segments may be dotted when namespaced)',
    ),
  domain: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
  privacy: agentIntentPrivacySchema.optional(),
  phrases: z.array(z.string()).optional(),
  /**
   * How CI-Server should execute the intent. `mcp` (default) routes to the app's
   * declared MCP server; `openapi` routes to a named OpenAPI operation.
   */
  binding: z
    .object({
      kind: z.enum(['mcp', 'openapi']).default('mcp'),
      tool: z.string().optional(),
      operation: z.string().optional(),
    })
    .optional(),
});

export const agentConfigSchema = z
  .object({
    skill: agentSkillConfigSchema.optional(),
    openapi: agentOpenApiConfigSchema.optional(),
    mcp: agentMcpConfigSchema.optional(),
    /**
     * Typed intents this app contributes to the CI Intent catalog. Declared here,
     * they register into CI-Server's catalog and become available to every harness
     * and MCP client — so a marketplace install grows the agent's capabilities.
     */
    intents: z.array(agentIntentSchema).optional(),
  })
  .optional();

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type AgentOpenApiConfig = z.infer<typeof agentOpenApiConfigSchema>;
export type AgentMcpConfig = z.infer<typeof agentMcpConfigSchema>;
export type AgentOpenApiAuth = z.infer<typeof agentOpenApiAuthSchema>;
export type AgentSkillConfig = z.infer<typeof agentSkillConfigSchema>;
export type AgentIntent = z.infer<typeof agentIntentSchema>;
export type AgentIntentPrivacy = z.infer<typeof agentIntentPrivacySchema>;
