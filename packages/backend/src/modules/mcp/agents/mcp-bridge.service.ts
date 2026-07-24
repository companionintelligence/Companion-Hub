import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '@/modules/docker/docker.service';
import { AppsService } from '@/modules/apps/apps.service';
import type { AppUrn } from '@ci-hub/common/types';
import type { ResolvedAgentConfig } from './agent-config.service';
import type { McpToolDefinition } from '../mcp-tool-registry.service';

interface McpConnection {
  appUrn: AppUrn;
  connected: boolean;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  config: NonNullable<ResolvedAgentConfig['mcp']['config']>;
  retryCount: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  abortController?: AbortController;
  /** Streamable-HTTP session id returned by the server's initialize response, if any. */
  sessionId?: string;
}

/**
 * Spec-required initialize params (#936): servers are entitled to reject an
 * `initialize` without protocolVersion/capabilities/clientInfo, and most reference
 * servers do. Sent on every connection, both transports.
 */
const INITIALIZE_PARAMS = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'ci-hub-mcp-bridge', version: '1.0.0' },
} as const;

/** A stdio server exited without emitting a single JSON-RPC line — it never got our input. */
class StdioSilentExitError extends Error {
  constructor(appUrn: string, code: number | null) {
    super(`MCP stdio server for ${appUrn} exited (code ${code}) without emitting any response`);
    this.name = 'StdioSilentExitError';
  }
}

/** Parse a JSON-RPC response that may arrive as plain JSON or as an SSE `data:` frame. */
async function parseJsonRpcHttpResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
      }
    }
    throw new Error('SSE response contained no data frame');
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export interface BridgedToolInfo {
  name: string;
  description: string;
  source: 'mcp';
}

/**
 * Connects to app MCP servers and bridges their tools.
 * Implements AMB-1 (SSE), AMB-2 (stdio), AMB-3 (lifecycle).
 */
@Injectable()
export class McpBridgeService implements OnModuleDestroy {
  private connections = new Map<string, McpConnection>();

  constructor(
    private readonly logger: LoggerService,
    readonly _dockerService: DockerService,
    private readonly appsService: AppsService,
  ) {}

  onModuleDestroy() {
    for (const conn of this.connections.values()) {
      this.disconnect(conn);
    }
    this.connections.clear();
  }

  /**
   * Generate bridged MCP tool definitions for an app.
   * S-AMB-1.2: Discover tools and re-expose under <appUrn>__<tool_name>
   * S-AMB-3.1: Connect lazily (first tool call triggers connection)
   */
  async generateTools(appUrn: AppUrn, agentConfig: ResolvedAgentConfig): Promise<McpToolDefinition[]> {
    if (!agentConfig.mcp.enabled || !agentConfig.mcp.config) {
      return [];
    }

    // Lazy connection — register tools that connect on first call
    const conn = this.getOrCreateConnection(appUrn, agentConfig.mcp.config);
    const prefix = appUrn.replace(':', '_');

    // If already connected, use cached tools
    if (conn.connected && conn.tools.length > 0) {
      return conn.tools.map((tool) => this.bridgeTool(appUrn, prefix, tool));
    }

    // Register a discovery tool that connects lazily
    return [
      {
        name: `${prefix}__discover`,
        description: `Connect to ${appUrn} MCP server and discover available tools. Call this first to enable direct app integration.`,
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: async () => {
          const tools = await this.connectAndDiscover(appUrn, conn);
          return { tools: tools.map((t) => ({ name: `${prefix}__${t.name}`, description: t.description })) };
        },
      },
    ];
  }

  /**
   * Connect (if needed) and return the app's bridged tools (#936). This is the entry
   * point `hub_list_app_tools` uses so callers see the real tool list instead of an
   * empty array until something else happens to have connected.
   */
  async discoverTools(appUrn: AppUrn, agentConfig: ResolvedAgentConfig): Promise<BridgedToolInfo[]> {
    if (!agentConfig.mcp.enabled || !agentConfig.mcp.config) {
      return [];
    }
    const conn = this.getOrCreateConnection(appUrn, agentConfig.mcp.config);
    if (!conn.connected) {
      await this.connectAndDiscover(appUrn, conn);
    }
    return this.listToolInfo(appUrn);
  }

  /**
   * Call one bridged tool by its bare (unprefixed) name — the invocation side of
   * `hub_call_app_tool` (#936). Accepts the prefixed form too, for callers pasting
   * names straight out of `hub_list_app_tools`.
   */
  async callTool(appUrn: AppUrn, agentConfig: ResolvedAgentConfig, toolName: string, params: Record<string, unknown>): Promise<unknown> {
    if (!agentConfig.mcp.enabled || !agentConfig.mcp.config) {
      return { error: `App ${appUrn} has no MCP server configured`, isError: true };
    }
    this.getOrCreateConnection(appUrn, agentConfig.mcp.config);
    const prefix = `${appUrn.replace(':', '_')}__`;
    const bareName = toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
    return this.callBridgedTool(appUrn, bareName, params);
  }

  /**
   * List all bridged tools for an app.
   * S-AOA-5.1: Returns all MCP-bridged tools
   * S-AOA-5.2: Each tool includes source: "mcp"
   */
  listToolInfo(appUrn: AppUrn): BridgedToolInfo[] {
    const conn = this.connections.get(appUrn);
    if (!conn?.connected) return [];

    const prefix = appUrn.replace(':', '_');
    return conn.tools.map((tool) => ({
      name: `${prefix}__${tool.name}`,
      description: tool.description,
      source: 'mcp' as const,
    }));
  }

  /**
   * Connect to an app's MCP server and discover tools.
   */
  private async connectAndDiscover(appUrn: AppUrn, conn: McpConnection): Promise<McpConnection['tools']> {
    // S-AMB-3.2: Check if app is running
    try {
      const { app } = await this.appsService.getApp(appUrn);
      if (!app || app.status !== 'running') {
        throw new Error(`App ${appUrn} is not running`);
      }
    } catch (_err) {
      throw new Error(`App ${appUrn} is not running`);
    }

    try {
      if (conn.config.transport === 'sse') {
        return await this.connectSse(appUrn, conn);
      }
      return await this.connectStdio(appUrn, conn);
    } catch (err) {
      // S-AMB-3.4: Retry with exponential backoff
      this.scheduleRetry(appUrn, conn);
      throw err;
    }
  }

  /**
   * S-AMB-1.1: Connect to app SSE MCP server
   */
  private async connectSse(appUrn: AppUrn, conn: McpConnection): Promise<McpConnection['tools']> {
    if (!conn.config.url) {
      throw new Error(`No MCP URL configured for ${appUrn}`);
    }

    const url = this.resolveTemplateUrl(conn.config.url, appUrn);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };

    // Auth
    if (conn.config.auth?.type === 'bearer' && conn.config.auth.token_env) {
      const token = process.env[conn.config.auth.token_env];
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }

    // Full handshake (#936): initialize with spec-required params, capture the
    // streamable-HTTP session id, acknowledge with notifications/initialized.
    const initResponse = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE_PARAMS }),
    });

    if (!initResponse.ok) {
      throw new Error(`MCP initialize failed for ${appUrn}: HTTP ${initResponse.status}`);
    }
    await parseJsonRpcHttpResponse(initResponse).catch(() => ({}));

    const sessionId = initResponse.headers.get('mcp-session-id');
    if (sessionId) {
      conn.sessionId = sessionId;
      headers['mcp-session-id'] = sessionId;
    }

    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }).catch(() => undefined);

    // Discover tools
    const listResponse = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    });

    if (!listResponse.ok) {
      throw new Error(`MCP tools/list failed for ${appUrn}: HTTP ${listResponse.status}`);
    }

    const listResult = (await parseJsonRpcHttpResponse(listResponse)) as { result?: { tools?: McpConnection['tools'] } };
    const tools = listResult.result?.tools ?? [];

    conn.connected = true;
    conn.tools = tools;
    conn.retryCount = 0;

    this.logger.info(`Connected to ${appUrn} MCP server via SSE, discovered ${tools.length} tools`);
    return tools;
  }

  /**
   * S-AMB-2.1: Connect via docker exec stdio
   * S-AMB-2.2: Container identified by container field or main service
   */
  private async connectStdio(appUrn: AppUrn, conn: McpConnection): Promise<McpConnection['tools']> {
    if (!conn.config.command || conn.config.command.length === 0) {
      throw new Error(`No MCP command configured for ${appUrn}`);
    }

    const result = (await this.stdioRequest(appUrn, conn, { method: 'tools/list', params: {} }, 15000)) as
      | { tools?: McpConnection['tools'] }
      | undefined;
    const tools = result?.tools ?? [];

    conn.connected = true;
    conn.tools = tools;
    conn.retryCount = 0;

    this.logger.info(`Connected to ${appUrn} MCP server via stdio, discovered ${tools.length} tools`);
    return tools;
  }

  /**
   * Run one MCP request against a stdio server via `docker exec -i` (#936).
   *
   * Each exec spawns a fresh server process, so every invocation performs the full
   * spec handshake — `initialize` (with required params) → `notifications/initialized`
   * → the actual request — and resolves the response line whose `id` matches the
   * request, rather than whatever happened to be printed last.
   */
  private async stdioRequest(
    appUrn: AppUrn,
    conn: McpConnection,
    request: { method: string; params: Record<string, unknown> },
    timeoutMs: number,
  ): Promise<unknown> {
    try {
      return await this.stdioRequestOnce(appUrn, conn, request, timeoutMs);
    } catch (err) {
      // `docker exec -i` can drop stdin that is written-and-closed before the exec
      // stream is fully attached; the server then sees immediate EOF and exits 0
      // having said nothing. That silence is the tell — the request was never
      // received, so one retry is safe even for side-effecting calls.
      if (err instanceof StdioSilentExitError) {
        this.logger.warn(`MCP stdio server for ${appUrn} exited silently (early stdin close?) — retrying once`);
        return this.stdioRequestOnce(appUrn, conn, request, timeoutMs);
      }
      throw err;
    }
  }

  private async stdioRequestOnce(
    appUrn: AppUrn,
    conn: McpConnection,
    request: { method: string; params: Record<string, unknown> },
    timeoutMs: number,
  ): Promise<unknown> {
    const containerName = conn.config.container ?? this.defaultMainContainerName(appUrn);
    const command = conn.config.command ?? [];
    const requestId = 2;

    const input = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE_PARAMS }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: requestId, method: request.method, params: request.params }),
    ]
      .map((line) => `${line}\n`)
      .join('');

    const { spawn } = await import('node:child_process');
    return new Promise((resolve, reject) => {
      const proc = spawn('docker', ['exec', '-i', containerName, ...command]);
      let stdout = '';
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        proc.kill();
        settle(() => reject(new Error(`MCP stdio timeout for ${appUrn} (${request.method})`)));
      }, timeoutMs);

      let sawAnyResponse = false;

      const tryResolveResponse = () => {
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as { id?: unknown; result?: unknown; error?: { message?: string } };
            sawAnyResponse = true;
            if (parsed.id === requestId) {
              proc.kill();
              if (parsed.error) {
                settle(() => reject(new Error(`MCP error from ${appUrn}: ${parsed.error?.message ?? 'unknown'}`)));
              } else {
                settle(() => resolve(parsed.result));
              }
              return;
            }
          } catch {
            // partial or non-JSON line — keep buffering
          }
        }
      };

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
        tryResolveResponse();
      });

      proc.stderr.on('data', (data: Buffer) => {
        this.logger.warn(`MCP stdio stderr (${appUrn}): ${data.toString()}`);
      });

      proc.on('close', (code) => {
        tryResolveResponse();
        settle(() =>
          reject(
            sawAnyResponse
              ? new Error(`MCP stdio server for ${appUrn} exited (code ${code}) without answering ${request.method}`)
              : new StdioSilentExitError(appUrn, code),
          ),
        );
      });

      proc.on('error', (err) => settle(() => reject(err)));
      proc.stdin.write(input);
      proc.stdin.end();
    });
  }

  /** Compose names containers `<project>-<service>-1`; the Hub's project is `<app>_<store>`. */
  private defaultMainContainerName(appUrn: AppUrn): string {
    const [appName, storeSlug] = appUrn.split(':') as [string, string];
    return `${appName}_${storeSlug}-${appName}-1`;
  }

  private bridgeTool(appUrn: AppUrn, prefix: string, tool: McpConnection['tools'][0]): McpToolDefinition {
    return {
      name: `${prefix}__${tool.name}`,
      description: tool.description,
      inputSchema: tool.inputSchema,
      handler: async (params) => this.callBridgedTool(appUrn, tool.name, params),
    };
  }

  /**
   * S-AMB-1.3: Forward tools/call to app's MCP server
   * S-AMB-3.2: Return error if app not running
   * S-AMB-3.3: Reconnect on next call if app restarted
   */
  private async callBridgedTool(appUrn: AppUrn, toolName: string, params: Record<string, unknown>): Promise<unknown> {
    const conn = this.connections.get(appUrn);
    if (!conn) {
      return { error: `App ${appUrn} is not running`, isError: true };
    }

    // Check if app is still running
    try {
      const { app } = await this.appsService.getApp(appUrn);
      if (!app || app.status !== 'running') {
        conn.connected = false;
        return { error: `App ${appUrn} is not running`, isError: true };
      }
    } catch {
      return { error: `App ${appUrn} is not running`, isError: true };
    }

    if (!conn.connected) {
      // S-AMB-3.3: Try to reconnect
      try {
        await this.connectAndDiscover(appUrn, conn);
      } catch (err) {
        return { error: `Failed to reconnect to ${appUrn}: ${err instanceof Error ? err.message : 'Unknown error'}`, isError: true };
      }
    }

    if (conn.config.transport === 'sse') {
      return this.callViaSse(appUrn, conn, toolName, params);
    }

    return this.callViaStdio(appUrn, conn, toolName, params);
  }

  private async callViaSse(appUrn: AppUrn, conn: McpConnection, toolName: string, params: Record<string, unknown>): Promise<unknown> {
    const url = this.resolveTemplateUrl(conn.config.url ?? '', appUrn);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (conn.sessionId) {
      headers['mcp-session-id'] = conn.sessionId;
    }

    if (conn.config.auth?.type === 'bearer' && conn.config.auth.token_env) {
      const token = process.env[conn.config.auth.token_env];
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: toolName, arguments: params },
      }),
    });

    // A 404 with a session header means the server dropped our session — reconnect once.
    if (response.status === 404 && conn.sessionId) {
      conn.connected = false;
      conn.sessionId = undefined;
      await this.connectAndDiscover(appUrn, conn);
      return this.callViaSse(appUrn, conn, toolName, params);
    }

    const result = await parseJsonRpcHttpResponse(response);
    return (result as { result?: unknown }).result ?? result;
  }

  private async callViaStdio(appUrn: AppUrn, conn: McpConnection, toolName: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.stdioRequest(appUrn, conn, { method: 'tools/call', params: { name: toolName, arguments: params } }, 30000);
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'MCP stdio call failed', isError: true };
    }
  }

  private getOrCreateConnection(appUrn: AppUrn, config: NonNullable<ResolvedAgentConfig['mcp']['config']>): McpConnection {
    let conn = this.connections.get(appUrn);
    if (!conn) {
      conn = { appUrn, connected: false, tools: [], config, retryCount: 0 };
      this.connections.set(appUrn, conn);
    }
    return conn;
  }

  /**
   * S-AMB-3.4: Exponential backoff (1s, 2s, 4s, max 30s)
   */
  private scheduleRetry(appUrn: AppUrn, conn: McpConnection): void {
    if (conn.retryTimer) return;

    const delay = Math.min(1000 * 2 ** conn.retryCount, 30000);
    conn.retryCount++;

    conn.retryTimer = setTimeout(() => {
      conn.retryTimer = undefined;
      this.connectAndDiscover(appUrn, conn).catch((err) => {
        this.logger.warn(`MCP retry failed for ${appUrn}: ${err instanceof Error ? err.message : 'Unknown'}`);
      });
    }, delay);
  }

  private disconnect(conn: McpConnection): void {
    if (conn.retryTimer) {
      clearTimeout(conn.retryTimer);
    }
    if (conn.abortController) {
      conn.abortController.abort();
    }
    conn.connected = false;
  }

  private resolveTemplateUrl(url: string, appUrn: AppUrn): string {
    const [storeSlug, appName] = appUrn.split(':') as [string, string];
    return url.replace(/\$\{APP_HOST\}/g, `${appName}-${storeSlug}`).replace(/\$\{APP_PORT\}/g, '');
  }
}
