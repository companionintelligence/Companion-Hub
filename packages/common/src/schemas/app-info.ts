import { z } from 'zod';
import { zodAppUrn } from '../types/app-urn.js';
import { agentConfigSchema } from './agent-config.js';

export const hubIntegrationSchema = z
  .object({
    mcp_client: z.boolean().default(false),
    wake_endpoint: z.string().optional().default('/hooks/hub-wake'),
    wake_port: z.number().optional(),
    sse_events: z.boolean().default(false),
  })
  .optional();

export type HubIntegration = z.output<typeof hubIntegrationSchema>;

export const APP_CATEGORIES = [
  'network',
  'media',
  'development',
  'automation',
  'social',
  'utilities',
  'photography',
  'security',
  'featured',
  'books',
  'data',
  'music',
  'finance',
  'gaming',
  'ai',
] as const;
export type AppCategory = (typeof APP_CATEGORIES)[number];
export const ARCHITECTURES = ['arm64', 'amd64'] as const;

export const FIELD_TYPES = ['text', 'password', 'email', 'number', 'fqdn', 'ip', 'fqdnip', 'url', 'random', 'boolean'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const RANDOM_ENCODINGS = ['hex', 'base64'] as const;
export type RandomEncoding = (typeof RANDOM_ENCODINGS)[number];

export const formFieldSchema = z.object({
  type: z.enum(FIELD_TYPES),
  label: z.string(),
  placeholder: z.string().optional(),
  max: z.number().optional(),
  min: z.number().optional(),
  hint: z.string().optional(),
  options: z.object({ label: z.string(), value: z.string() }).array().optional(),
  required: z.boolean().optional().default(false),
  default: z.union([z.boolean(), z.string(), z.number()]).optional(),
  regex: z.string().optional(),
  pattern_error: z.string().optional(),
  env_variable: z.string(),
  encoding: z.enum(RANDOM_ENCODINGS).optional(),
});

/** Accept legacy Runtipi field names when parsing app config.json from stores or backups. */
function normalizeAppInfoInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const raw = input as Record<string, unknown>;
  return {
    ...raw,
    cihub_app_version:
      typeof raw.cihub_app_version === 'number' ? raw.cihub_app_version : typeof raw.tipi_version === 'number' ? raw.tipi_version : 1,
    min_hub_version:
      typeof raw.min_hub_version === 'string' ? raw.min_hub_version : typeof raw.min_tipi_version === 'string' ? raw.min_tipi_version : undefined,
  };
}

export const appInfoObjectSchema = z.object({
  id: z.string().refine((v) => v.split(':').length === 1),
  urn: zodAppUrn,
  available: z.boolean(),
  deprecated: z.boolean().optional().default(false),
  port: z.number().min(1).max(65535).optional(),
  name: z.string(),
  description: z.string().optional().default(''),
  version: z.string().optional().default('latest'),
  cihub_app_version: z.number(),
  short_desc: z.string(),
  author: z.string(),
  source: z.string(),
  website: z.string().optional(),
  force_expose: z.boolean().optional().default(false),
  generate_vapid_keys: z.boolean().optional().default(false),
  categories: z.enum(APP_CATEGORIES).array().default(['utilities']),
  url_suffix: z.string().optional(),
  form_fields: z.array(formFieldSchema).optional().default([]),
  https: z.boolean().optional().default(false),
  exposable: z.boolean().optional().default(true),
  no_gui: z.boolean().optional().default(false),
  supported_architectures: z.enum(ARCHITECTURES).array().default(['amd64', 'arm64']),
  uid: z.number().optional(),
  gid: z.number().optional(),
  dynamic_config: z.boolean().optional().default(true),
  min_hub_version: z.string().optional(),
  created_at: z
    .number()
    .int()
    .min(0)
    .refine((v) => v < Date.now())
    .optional()
    .default(0),
  updated_at: z
    .number()
    .int()
    .min(0)
    .refine((v) => v < Date.now())
    .optional()
    .default(0),
  force_pull: z.boolean().optional().default(false),
  agents: agentConfigSchema,
  hub_integration: hubIntegrationSchema,
});

export const appInfoSchema = z.preprocess(normalizeAppInfoInput, appInfoObjectSchema);

// Derived types
export type AppInfoInput = z.input<typeof appInfoSchema>;
export type AppInfo = z.output<typeof appInfoSchema>;
export type FormField = z.output<typeof formFieldSchema>;

export const frontmatterSchema = z
  .object({
    name: appInfoObjectSchema.shape.name.optional(),
    short_desc: appInfoObjectSchema.shape.short_desc.optional(),
    description: appInfoObjectSchema.shape.description.optional(),
    source: appInfoObjectSchema.shape.source.optional(),
    website: appInfoObjectSchema.shape.website.optional(),
    author: appInfoObjectSchema.shape.author.optional(),
    categories: appInfoObjectSchema.shape.categories.optional().default(['development']),
    version: appInfoObjectSchema.shape.version.optional(),
    port: appInfoObjectSchema.shape.port.optional(),
    supported_architectures: appInfoObjectSchema.shape.supported_architectures.optional().default(['amd64', 'arm64']),
  })
  .optional();
