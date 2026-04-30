/** OpenClaw Plugin API interface (provided by OpenClaw runtime) */
export interface OpenClawPluginApi {
  registerTool(tool: OpenClawTool): void;
  registerHttpRoute(route: OpenClawHttpRoute): void;
  registerProvider?(provider: OpenClawProvider): void;
  registerSpeechProvider?(provider: OpenClawSpeechProvider): void;
  wake(message: string): void;
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    debug(message: string): void;
  };
}

export interface OpenClawTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface OpenClawHttpRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  handler: (req: OpenClawHttpRequest) => Promise<OpenClawHttpResponse>;
}

export interface OpenClawHttpRequest {
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface OpenClawHttpResponse {
  status: number;
  body: unknown;
}

export interface PluginConfig {
  hubUrl?: string;
  hubApiKey?: string;
  mcpApiKey?: string;
  wakeSecret?: string;
  sseEnabled?: boolean;
  wakeFilter?: {
    minUrgency?: 'info' | 'low' | 'medium' | 'high';
    events?: string[];
  };
}

export interface WakePayload {
  event: string;
  data: Record<string, unknown>;
  urgency: string;
  timestamp: string;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Provider registration for OpenClaw model catalog */
export interface OpenClawProvider {
  id: string;
  label: string;
  resolveSyntheticAuth?: () => { available: boolean; apiKey: string };
  catalog: {
    order: 'simple';
    run: (ctx: unknown) => Promise<{
      provider: {
        baseUrl: string;
        apiKey: string;
        api: 'openai-completions';
        models: OpenClawModelEntry[];
      };
    }>;
  };
}

export interface OpenClawModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

/** Speech provider registration */
export interface OpenClawSpeechProvider {
  id: string;
  label: string;
  isConfigured: () => boolean;
  synthesize: (req: { text: string; voice?: string }) => Promise<{
    audioBuffer: Buffer;
    outputFormat: string;
    fileExtension: string;
    voiceCompatible: boolean;
  }>;
}

/** Inference status from Hub */
export interface HubInferenceStatus {
  hardwareTier: string;
  backends: Array<{
    type: string;
    running: boolean;
    healthy: boolean;
    url: string;
    modelsLoaded: number;
  }>;
  models: HubInferenceModel[];
  memoryBudget: Record<string, number>;
  cloudProviders: Array<{
    provider: string;
    enabled: boolean;
    configured: boolean;
  }>;
}

export interface HubInferenceModel {
  id: string;
  object: string;
  owned_by: string;
  state: string;
  backend: string;
  modality: string[];
  local: boolean;
  context_window?: number;
  max_tokens?: number;
}
