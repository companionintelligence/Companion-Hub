/** OpenClaw Plugin API interface (provided by OpenClaw runtime) */
export interface OpenClawPluginApi {
  registerTool(tool: OpenClawTool): void;
  registerHttpRoute(route: OpenClawHttpRoute): void;
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
