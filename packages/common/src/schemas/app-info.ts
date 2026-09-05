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
  // Native Ollama URL dedicated to embeddings. Unlike `ollama_host` (only set
  // when Ollama is the active chat backend), this is emitted whenever a healthy
  // Ollama is reachable — so an app can run chat on vLLM/Lemonade while keeping
  // its embedding pipeline (and existing pgvector index) on Ollama.
  'ollama_embed_host',
  'num_ctx',
] as const;
export type InferenceVariable = (typeof INFERENCE_VARIABLES)[number];

// Zod 4's `z.record(z.enum(...), …)` requires every enum key. Apps opt into a
// subset of inference vars (e.g. ci-memory declares llm_* only), so this must
// be a partial record — otherwise marketplace config fails safeParse and the
// Hub reports "App ci-memory:ci-marketplace not found".
export const inferenceEnvMappingSchema = z.partialRecord(z.enum(INFERENCE_VARIABLES), z.string().min(1));

/**
 * Dual-provider apps (e.g. AnythingLLM) expose an internal provider switch env var.
 * The Hub sets it from the active inference backend: Ollama vs OpenAI-compatible
 * (vLLM, Lemonade, cloud).
 */
export const inferenceProviderSchema = z.object({
  /** Env variable the app reads its LLM provider mode from (e.g. APP_LLM_PROVIDER). */
  env: z
    .string()
    .min(1)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'env must be a valid environment variable name'),
  /** Value to write when Hub AI Settings use Ollama as the chat backend. */
  ollama: z.string().min(1),
  /** Value to write when Hub AI Settings use vLLM, Lemonade, or cloud. */
  openai_compatible: z.string().min(1),
});

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
     * Optional provider-mode switch for dual-provider marketplace apps. When
     * declared alongside `inference`, the Hub writes `env` to `ollama` or
     * `openai_compatible` based on the active chat backend at env-generation time.
     */
    inference_provider: inferenceProviderSchema.optional(),
    /**
     * When true, strip a trailing `/v1` from resolved `llm_base_url` before writing
     * it into the app's env. Use when the app expects a bare origin (e.g. vLLM on
     * :8000) rather than an OpenAI-compatible `/v1` suffix.
     */
    llm_base_url_strip_v1: z.boolean().optional(),
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
    /**
     * Edge-auth posture the app ships with (CI-Engineering#74).
     *
     * `default: true` asks the Hub to default the install/expose "Require Auth" toggle ON for
     * this app, so a fresh install sits behind the Hub-session forward-auth middleware without
     * the operator having to remember the toggle. It only supplies the FALLBACK for an
     * undecided value: an explicit operator choice (form or API) always wins, and the field can
     * never force auth OFF (`default: false` and absence are equally no-ops — absence already
     * means "leave the toggle default alone").
     *
     * Deliberately honored from ANY store, unlike the credential provisioning gates: the field
     * is strictly safety-increasing — the worst a hostile manifest can do is put its own app
     * behind the Hub login (self-lockout, no privilege gained), while the dangerous direction
     * is unreachable by construction.
     */
    edge_auth: z
      .object({
        /** Default the "Require Auth" toggle ON at install/expose time. */
        default: z.boolean().optional(),
      })
      .optional(),
  })
  .optional();

export type HubIntegration = z.output<typeof hubIntegrationSchema>;

/**
 * Whether a manifest asks for edge auth ON by default. Only exposable apps qualify — the toggle
 * is meaningless for apps that are never routed — and only an explicit `default: true` counts.
 * Shared between the backend (which enforces the fallback for formless installs, e.g.
 * onboarding) and the frontend (which mirrors it in the install form), so the two can't drift.
 */
export function manifestDefaultsEdgeAuthOn(info: { exposable?: boolean; hub_integration?: HubIntegration }): boolean {
  return Boolean(info.exposable) && info.hub_integration?.edge_auth?.default === true;
}

/**
 * How a consumer wants the brokered Companion Memory address shaped. Derived from the
 * schema rather than restated, so a new style cannot be added in one place and silently
 * unhandled in the other.
 */
export type MemoryUrlStyle = NonNullable<NonNullable<NonNullable<HubIntegration>['memory']>['url_style']>;

/**
 * Marketplace MCP listing block (#936). CI-Marketplace ships MCP server apps with a
 * top-level `mcp` object in config.json describing transport, launch command, required
 * env, and a manifest of the tools the server exposes. The Hub ingests this block so
 * installed MCP servers are visible to the agent bridge (`McpBridgeService`) and the
 * app page can render an access card — without requiring stores to duplicate the
 * information into the Hub-native `agents.mcp` shape.
 *
 * Loose objects throughout: the marketplace owns this contract and extends it over
 * time (tags, requires, manifest extras); unknown fields must never fail an install.
 */
export const MCP_TRANSPORTS = ['stdio', 'http'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const MCP_LAUNCH_MODES = ['container_exec', 'host_docker'] as const;
export type MarketplaceMcpLaunchMode = (typeof MCP_LAUNCH_MODES)[number];

export const mcpEnvVarSchema = z.looseObject({
  key: z.string(),
  label: z.string().optional(),
  hint: z.string().optional(),
  required: z.boolean().optional().default(false),
  secret: z.boolean().optional().default(false),
});

/** Auth the Hub bridge sends when connecting to an HTTP MCP server. */
export const marketplaceMcpAuthSchema = z.looseObject({
  type: z.enum(['bearer', 'basic', 'api_key', 'none']).default('bearer'),
  token_env: z.string(),
  header: z.string().optional(),
  api_key_name: z.string().optional(),
  api_key_in: z.enum(['header', 'query']).optional(),
});

export const mcpManifestSchema = z.looseObject({
  tools: z
    .array(z.looseObject({ name: z.string(), description: z.string().optional().default('') }))
    .optional()
    .default([]),
  resources: z.array(z.unknown()).optional().default([]),
  prompts: z.array(z.unknown()).optional().default([]),
});

export const marketplaceMcpSchema = z.looseObject({
  transport: z.enum(MCP_TRANSPORTS),
  /**
   * How CI Hub spawns stdio servers:
   * - `container_exec` (default): `docker exec -i <main-container> <command…>`
   * - `host_docker`: run `<command…>` on the Hub host (for catalog entries whose MCP is `docker run …`)
   */
  launch: z.enum(MCP_LAUNCH_MODES).optional(),
  /** Executable for stdio servers (e.g. "uvx"); empty/absent for hosted http listings. */
  command: z.string().optional().default(''),
  args: z.array(z.string()).optional().default([]),
  /** Endpoint for http-transport servers, when the listing pins one. */
  url: z.string().optional(),
  /** Bearer/basic auth for HTTP MCP endpoints (token read from app.env at bridge time). */
  auth: marketplaceMcpAuthSchema.optional(),
  env: z.array(mcpEnvVarSchema).optional().default([]),
  requires: z
    .looseObject({
      host_software: z.array(z.string()).optional(),
      notes: z.string().optional(),
    })
    .optional(),
  tags: z.array(z.string()).optional().default([]),
  manifest: mcpManifestSchema.optional(),
});
export type MarketplaceMcp = z.output<typeof marketplaceMcpSchema>;

// ── App privacy declaration ────────────────────────────────────────────────

/**
 * Categories of user data an app may declare it collects. Deliberately coarse:
 * a declaration is a promise made to the person installing the app, not a
 * compliance artifact, and a long tail of near-identical categories only makes
 * it easier to under-declare.
 */
export const PRIVACY_DATA_CATEGORIES = [
  'contact_info',
  'health_fitness',
  'financial_info',
  'location',
  'sensitive_info',
  'contacts',
  'user_content',
  'browsing_history',
  'search_history',
  'identifiers',
  'usage_data',
  'diagnostics',
  'other_data',
] as const;
export type PrivacyDataCategory = (typeof PRIVACY_DATA_CATEGORIES)[number];

/** Why a declared category is collected. At least one per collection entry. */
export const PRIVACY_DATA_PURPOSES = [
  'app_functionality',
  'analytics',
  'product_personalization',
  'developer_advertising',
  'third_party_advertising',
  'other_purposes',
] as const;
export type PrivacyDataPurpose = (typeof PRIVACY_DATA_PURPOSES)[number];

export const privacyCollectionSchema = z.object({
  category: z.enum(PRIVACY_DATA_CATEGORIES),
  purposes: z.enum(PRIVACY_DATA_PURPOSES).array().min(1),
  /** Whether the collected data is tied to the user's identity. */
  linked_to_identity: z.boolean().optional().default(false),
  /** Whether the data is used to track the user across other apps or sites. */
  used_for_tracking: z.boolean().optional().default(false),
});
export type PrivacyCollection = z.output<typeof privacyCollectionSchema>;

/**
 * An app's privacy declaration.
 *
 * The PRESENCE of this block is the declaration — it is what lets a store
 * surface say "the developer has provided details about how this app handles
 * your data". Its ABSENCE means nobody has declared anything, which is NOT the
 * same claim as "no data collected" and must never be rendered as one.
 *
 * An affirmative "this app collects nothing" is `collects: []` — an empty list
 * someone signed their name to via `declared_by`.
 */
export const appPrivacySchema = z.object({
  /** Who stands behind this declaration (developer, org, or packager). */
  declared_by: z.string().min(1),
  /** ISO date (YYYY-MM-DD) the declaration was last affirmed. */
  declared_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'declared_at must be an ISO date (YYYY-MM-DD)'),
  policy_url: z.url().optional(),
  /** Empty array is meaningful: an affirmative declaration of no collection. */
  collects: z.array(privacyCollectionSchema),
});
export type AppPrivacy = z.output<typeof appPrivacySchema>;

/**
 * Three-state read of an app's privacy posture. `undeclared` is the default for
 * a catalog entry that has never carried a declaration — surfaces must render
 * it as unknown, not as a clean bill of health.
 */
export type AppPrivacyState = 'undeclared' | 'no_collection' | 'collects';

export function appPrivacyState(privacy?: AppPrivacy | null): AppPrivacyState {
  if (!privacy) return 'undeclared';
  return privacy.collects.length === 0 ? 'no_collection' : 'collects';
}

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
  'agents',
  'mcp',
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

function normalizeReplaces(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (name) names.push(name);
  }
  return names;
}

/** Accept legacy CIHub field names when parsing app config.json from stores or backups. */
function normalizeAppInfoInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const raw = input as Record<string, unknown>;
  return {
    ...raw,
    cihub_app_version:
      typeof raw.cihub_app_version === 'number' ? raw.cihub_app_version : typeof raw.cihub_version === 'number' ? raw.cihub_version : 1,
    min_hub_version:
      typeof raw.min_hub_version === 'string' ? raw.min_hub_version : typeof raw.min_cihub_version === 'string' ? raw.min_cihub_version : undefined,
    // Late-added field: missing, null, or junk must not fail the whole app parse
    // or the store hides the listing. Coerce to [] and keep the app visible.
    replaces: normalizeReplaces(raw.replaces),
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
  /**
   * Popular proprietary products this app replaces (e.g. Nextcloud →
   * "Google Drive", "Dropbox"). Indexed by store search. Do not stuff these
   * into `short_desc` — that field is human copy, not a synonym list.
   */
  replaces: z.array(z.string().min(1)).optional().nullable().default([]),
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
  /** Absolute URLs or relative paths to screenshot assets (e.g. metadata/screenshots/…). */
  screenshots: z.array(z.string().min(1)).optional(),
  /** Absolute URL or relative path to a demo/preview video (e.g. metadata/media/…). */
  demo_video: z.string().min(1).optional(),
  /** Discriminator for user workloads that proxy an existing host port (no Docker app). */
  kind: z.enum(['port-expose']).optional(),
  /** Host port the workload listens on when `kind` is `port-expose`. */
  upstreamPort: z.number().min(1).max(65535).optional(),
  agents: agentConfigSchema,
  /** Marketplace MCP server listing block — see marketplaceMcpSchema (#936). */
  mcp: marketplaceMcpSchema.optional(),
  /**
   * Optional privacy declaration — see appPrivacySchema. Optional because most
   * of the catalog is repackaged third-party software nobody has declared for
   * yet; undefined means "undeclared", never "collects nothing".
   */
  privacy: appPrivacySchema.optional(),
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
