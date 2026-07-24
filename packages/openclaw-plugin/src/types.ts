export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/**
 * OpenClaw Plugin API interface (provided by OpenClaw runtime).
 *
 * NOTE: `log` is typed as present because consumers here always receive it — but the
 * OpenClaw runtime does NOT reliably supply it (its own bundled plugins all call it
 * defensively, as `api.log?.info?.()`). register() normalizes the api through
 * withSafeLogger() before handing it to anything, so downstream code can rely on it.
 * Calling `api.log.info()` on the RAW api OpenClaw passes will throw.
 *
 * This plugin deliberately covers only the non-inference surface (wake webhook, app-event
 * SSE, health probe): it does NOT register an LLM/model or speech provider. A provider
 * registered through the plugin API resolves against OpenClaw's api-provider registry, which
 * has no `ollama` implementation, so it cannot serve the appliance's local models — those
 * come from openclaw.json's `models.providers.ci-hub` (written by config-reconcile). See
 * CI-Hub#895.
 */
export interface OpenClawPluginApi {
  registerTool(tool: OpenClawTool): void;
  registerHttpRoute(route: OpenClawHttpRoute): void;
  wake(message: string): void;
  log: PluginLogger;
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
