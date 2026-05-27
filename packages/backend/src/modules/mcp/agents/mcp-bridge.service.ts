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
}

export interface BridgedToolInfo {
  name: string;
  description: string;
  source: 'mcp';
}

export interface RemoteMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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
   * Discover and cache the raw MCP tools exposed by an app server.
   */
  async listRemoteTools(appUrn: AppUrn, agentConfig: ResolvedAgentConfig): Promise<RemoteMcpTool[]> {
    if (!agentConfig.mcp.enabled || !agentConfig.mcp.config) {
      return [];
    }

    const conn = this.getOrCreateConnection(appUrn, agentConfig.mcp.config);
    if (conn.connected && conn.tools.length > 0) {
      return conn.tools;
    }

    return this.connectAndDiscover(appUrn, conn);
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
    const headers: Record<string, string> = {};

    // Auth
    if (conn.config.auth?.type === 'bearer' && conn.config.auth.token_env) {
      const token = process.env[conn.config.auth.token_env];
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }

    // Send initialize
    const initResponse = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      }),
    });

    if (!initResponse.ok) {
      throw new Error(`MCP initialize failed for ${appUrn}: HTTP ${initResponse.status}`);
    }

    // Discover tools
    const listResponse = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
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

    const listResult = (await listResponse.json()) as { result?: { tools?: McpConnection['tools'] } };
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

    // For stdio, we'll use docker exec to communicate
    // The container name is derived from the compose project + service
    const [storeSlug, appName] = appUrn.split(':') as [string, string];
    const containerName = conn.config.container ?? `${appName}-${storeSlug}`;
    const command = conn.config.command;

    // Execute initialize + tools/list via stdin/stdout
    const initPayload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const listPayload = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const input = `${initPayload}\n${listPayload}\n`;

    const { spawn } = await import('node:child_process');
    const tools = await new Promise<McpConnection['tools']>((resolve, reject) => {
      const proc = spawn('docker', ['exec', '-i', containerName, ...command]);
      let stdout = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        this.logger.warn(`MCP stdio stderr (${appUrn}): ${data.toString()}`);
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`docker exec failed with code ${code}`));
          return;
        }

        try {
          // Parse the last JSON-RPC response (tools/list result)
          const lines = stdout.trim().split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const parsed = JSON.parse(lines[i] ?? '{}') as { result?: { tools?: McpConnection['tools'] } };
              if (parsed.result?.tools) {
                resolve(parsed.result.tools);
                return;
              }
            } catch {
              // Not a valid JSON-RPC response line, skip
            }
          }
          resolve([]);
        } catch {
          resolve([]);
        }
      });

      proc.on('error', reject);
      proc.stdin.write(input);
      proc.stdin.end();

      setTimeout(() => {
        proc.kill();
        reject(new Error(`MCP stdio timeout for ${appUrn}`));
      }, 10000);
    });

    conn.connected = true;
    conn.tools = tools;
    conn.retryCount = 0;

    this.logger.info(`Connected to ${appUrn} MCP server via stdio, discovered ${tools.length} tools`);
    return tools;
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
    const headers: Record<string, string> = { 'content-type': 'application/json' };

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

    const result = await response.json();
    return (result as { result?: unknown }).result ?? result;
  }

  private async callViaStdio(appUrn: AppUrn, conn: McpConnection, toolName: string, params: Record<string, unknown>): Promise<unknown> {
    const [storeSlug, appName] = appUrn.split(':') as [string, string];
    const containerName = conn.config.container ?? `${appName}-${storeSlug}`;
    const command = conn.config.command ?? [];

    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: params },
    });

    const { spawn } = await import('node:child_process');
    return new Promise((resolve) => {
      const proc = spawn('docker', ['exec', '-i', containerName, ...command]);
      let stdout = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      proc.on('close', () => {
        try {
          const parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { result?: unknown };
          resolve(parsed.result ?? parsed);
        } catch {
          resolve({ error: 'Failed to parse MCP response', isError: true });
        }
      });
      proc.on('error', () => resolve({ error: 'docker exec failed', isError: true }));
      proc.stdin.write(`${payload}\n`);
      proc.stdin.end();

      setTimeout(() => {
        proc.kill();
        resolve({ error: 'MCP call timeout', isError: true });
      }, 30000);
    });
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
