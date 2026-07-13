import { z } from 'zod';
import { zodAppUrn } from '../types/app-urn.js';
import { agentConfigSchema } from './agent-config.js';

/**
 * Standardized inference variable names that apps can request from the Hub.
 * When declared in `hub_integration.inference`, the Hub resolves the value at
 * env-generation time and writes it into the app's `app.env` under the
 * app-specified env variable name.
 */
export const INFERENCE_VARIABLES = [
  'llm_base_url',
  'llm_api_key',
  'chat_model',
  'embedding_model',
  'vision_model',
  'ollama_host',
  'num_ctx',
] as const;
export type InferenceVariable = (typeof INFERENCE_VARIABLES)[number];

export const inferenceEnvMappingSchema = z.record(z.enum(INFERENCE_VARIABLES), z.string().min(1));

export const hubIntegrationSchema = z
  .object({
    mcp_client: z.boolean().default(false),
    wake_endpoint: z.string().optional().default('/hooks/hub-wake'),
    wake_port: z.number().optional(),
    sse_events: z.boolean().default(false),
    /**
     * Opt-in inference variable mapping. Keys are standardized Hub variable
     * names; values are the env variable names the app expects.
     *
     * Example in config.json:
     * ```json
     * "hub_integration": {
     *   "inference": {
     *     "llm_base_url": "LLM_API_BASE",
     *     "llm_api_key": "LLM_API_KEY",
     *     "chat_model": "LLM_DEFAULT_CHAT_MODEL",
     *     "embedding_model": "LLM_DEFAULT_EMBEDDING_MODEL"
     *   }
     * }
     * ```
     */
    inference: inferenceEnvMappingSchema.optional(),
    /**
     * Opt-in Portal OIDC issuer injection. Apps that "Sign in with CI-Portal"
     * must authenticate against the *paired* Portal IdP (CI_CLOUD_URL), not a
     * hardcoded default — otherwise an exposed app is redirected to the wrong
     * IdP and fails with `INVALID_REDIRECT_URI`.
     *
     * When declared, the Hub resolves the paired Portal origin (CI_CLOUD_URL)
     * at env-generation time and writes it into the app's `app.env` under the
     * app-declared env variable name. This mirrors the `inference` opt-in
     * mapping: only apps that opt in are touched, so a third-party app that
     * reads a same-named var for its own IdP is never clobbered.
     *
     * Example in config.json:
     * ```json
     * "hub_integration": {
     *   "oidc": {
     *     "issuer_env": "CI_OIDC_ISSUER",
     *     "issuer_path": "/api/auth"
     *   }
     * }
     * ```
     */
    oidc: z
      .object({
        /**
         * Env variable name the app reads its OIDC issuer from (e.g. "CI_OIDC_ISSUER").
         * Must be a valid environment variable name so it is never written as a
         * malformed/whitespace-padded key (which would silently misconfigure OIDC).
         */
        issuer_env: z
          .string()
          .min(1)
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'issuer_env must be a valid environment variable name'),
        /**
         * Optional path appended to the paired Portal origin to form the issuer
         * (e.g. "/api/auth" for discovery-based clients that resolve
         * `<issuer>/.well-known/openid-configuration`). Omit for a bare-origin
         * issuer (e.g. CI-Server, which appends its own auth paths).
         *
         * Must not contain whitespace: the composed issuer is written verbatim
         * into the app's `app.env` (an unescaped `KEY=value` line), so a newline
         * here would inject an arbitrary extra environment line.
         */
        issuer_path: z.string().regex(/^\S*$/, 'issuer_path must not contain whitespace').optional(),
      })
      .optional(),
    /**
     * Opt-in Companion Memory (ci-memory / CI-Server) integration.
     *
     * Two independent roles:
     *
     * - **Consumer** (OpenClaw / Hermes / Import-Tools): declares the env
     *   variable names the app reads its memory URL + api key from. When the
     *   user connects the app (see the memory-connect flow), the Hub injects the
     *   resolved values into these vars at env-generation time — mirroring the
     *   `inference` / `oidc` opt-in mappings, so only apps that opt in are
     *   touched. Presence of BOTH `url_env` and `token_env` marks a consumer.
     *
     * - **Provider** (ci-memory): declares the internal compose service + port
     *   so the Hub can reach it on the shared network for the server-to-server
     *   code exchange (the public URL is resolved separately for the browser).
     *
     * Example (consumer, ci-openclaw):
     * ```json
     * "hub_integration": {
     *   "memory": { "url_env": "CI_SERVER_URL", "token_env": "CI_SERVER_TOKEN" }
     * }
     * ```
     * Example (provider, ci-memory):
     * ```json
     * "hub_integration": {
     *   "memory": { "provider": { "service": "gateway", "port": 8642 } }
     * }
     * ```
     */
    memory: z
      .object({
        /** Env var to receive the resolved Companion Memory URL (must be a valid env name). */
        url_env: z
          .string()
          .min(1)
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'url_env must be a valid environment variable name')
          .optional(),
        /** Env var to receive the minted, memory-scoped api key (must be a valid env name). */
        token_env: z
          .string()
          .min(1)
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'token_env must be a valid environment variable name')
          .optional(),
        /**
         * The SHAPE of the URL this app wants in `url_env`. The provider is reachable
         * at `http://<service>:<port>`, but its gateway only proxies the API under
         * `/api/`, so consumers disagree about what to be handed:
         *
         * - `origin` (default) — the bare origin `http://gateway:8642`. For apps that
         *   append the full path themselves (CI-OpenClaw / CI-Hermes hardcode
         *   `/api/memory/...`). Giving them an `/api` base would double the prefix.
         * - `api_base` — `http://gateway:8642/api`. For apps that treat the value as
         *   the API base and append server-local paths to it (CI-Import-Tools derives
         *   `<base>/graphql`, `<base>/v1/...`). A bare origin sends those to the SPA.
         *
         * Declared here, rather than sniffed by the consumer, because only the Hub
         * knows whether a value it is injecting is the brokered provider address at
         * all — an operator-supplied "external, self-managed CI-Server" URL must be
         * passed through untouched.
         */
        url_style: z.enum(['origin', 'api_base']).optional(),
        /** Provider role (ci-memory only): where the Hub reaches it on the shared docker network. */
        provider: z
          .object({
            service: z.string().min(1),
            port: z.number().min(1).max(65535),
          })
          .optional(),
      })
      .optional(),
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
  'companion-intelligence',
] as const;
export type AppCategory = (typeof APP_CATEGORIES)[number];
export const ARCHITECTURES = ['arm64', 'amd64'] as const;

export const FIELD_TYPES = ['text', 'password', 'email', 'number', 'fqdn', 'ip', 'fqdnip', 'url', 'app_base_url', 'random', 'boolean'] as const;
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
  /** When set on `app_base_url`, also write the resolved value to these env vars. */
  alias_env_variables: z.array(z.string().min(1)).optional(),
  /** When true, append a trailing slash to alias env var values. */
  trailing_slash: z.boolean().optional(),
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
  cihub_app_version: z.number().optional().default(1),
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
  /** When set, Hub pins all compose services to this Docker platform (e.g. linux/amd64 on Apple Silicon). */
  runtime_platform: z.string().optional(),
  /** Discriminator for user workloads that proxy an existing host port (no Docker app). */
  kind: z.enum(['port-expose']).optional(),
  /** Host port the workload listens on when `kind` is `port-expose`. */
  upstreamPort: z.number().min(1).max(65535).optional(),
  agents: agentConfigSchema,
  hub_integration: hubIntegrationSchema,
});

export const appInfoSchema = z.preprocess(normalizeAppInfoInput, appInfoObjectSchema);

export type AppInfoInput = z.input<typeof appInfoObjectSchema>;
export type AppInfo = z.output<typeof appInfoObjectSchema>;
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
