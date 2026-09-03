import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '@/modules/docker/docker.service';
import { AppsService } from '@/modules/apps/apps.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { EnvUtils } from '@/modules/env/env.utils';
import type { AppUrn } from '@ci-hub/common/types';
import type { ResolvedAgentConfig } from './agent-config.service';
import type { McpToolDefinition } from '../mcp-tool-registry.service';
import { McpStreamableHttpClient } from './mcp-streamable-http-client';
import { McpStdioSession, StdioSilentExitError, type StdioSpawnSpec } from './mcp-stdio-session';

interface McpConnection {
  appUrn: AppUrn;
  connected: boolean;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  config: NonNullable<ResolvedAgentConfig['mcp']['config']>;
  retryCount: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  abortController?: AbortController;
  /** Streamable-HTTP session id returned by the upstream server, if any. */
  sessionId?: string;
  /** SDK client for upstream Streamable HTTP MCP servers. */
  httpClient?: McpStreamableHttpClient;
  /** Reused stdio process for container_exec and host_docker listings. */
  stdioSession?: McpStdioSession;
}

/** Legacy `sse` alias and canonical `streamable-http` both mean Streamable HTTP transport. */
const isStreamableHttpTransport = (transport: string): boolean => transport === 'streamable-http' || transport === 'sse';

const isHostDockerLaunch = (launch: string | undefined): boolean => launch === 'host_docker';

export interface BridgedToolInfo {
  name: string;
  description: string;
  source: 'mcp';
}

/**
 * Connects to app MCP servers and bridges their tools.
 * Implements AMB-1 (Streamable HTTP), AMB-2 (stdio), AMB-3 (lifecycle).
 */
@Injectable()
export class McpBridgeService implements OnModuleDestroy {
  private connections = new Map<string, McpConnection>();

  constructor(
    private readonly logger: LoggerService,
    readonly _dockerService: DockerService,
    private readonly appsService: AppsService,
    private readonly appFilesManager: AppFilesManager,
    private readonly envUtils: EnvUtils,
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

    // Eager discovery when the app is already running — avoids exposing only __discover.
    if (!conn.connected || conn.tools.length === 0) {
      try {
        const { app } = await this.appsService.getApp(appUrn);
        const canDiscover = isHostDockerLaunch(agentConfig.mcp.config?.launch) ? Boolean(app) : app?.status === 'running';
        if (canDiscover) {
          await this.connectAndDiscover(appUrn, conn);
        }
      } catch {
        // Fall back to lazy discover tool below.
      }
    }

    // If connected, expose bridged tools directly.
    if (conn.connected && conn.tools.length > 0) {
      return conn.tools.map((tool) => this.bridgeTool(appUrn, prefix, tool));
    }

    // Register a discovery tool that connects lazily
    return [
      {
        name: `${prefix}__discover`,
        // Discovery only: it opens a connection and asks what the app offers, changing nothing on the
        // appliance, so a read-only key is entitled to see what is there.
        access: 'read',
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
    await this.assertBridgeable(appUrn, conn);

    try {
      if (isStreamableHttpTransport(conn.config.transport)) {
        return await this.connectStreamableHttp(appUrn, conn);
      }
      return await this.connectStdio(appUrn, conn);
    } catch (err) {
      this.scheduleRetry(appUrn, conn);
      throw err;
    }
  }

  /** host_docker listings only need install + credentials; container_exec needs a running app. */
  private async assertBridgeable(appUrn: AppUrn, conn: McpConnection): Promise<void> {
    try {
      const { app } = await this.appsService.getApp(appUrn);
      if (!app) {
        throw new Error(`App ${appUrn} is not installed`);
      }
      if (!isHostDockerLaunch(conn.config.launch) && app.status !== 'running') {
        throw new Error(`App ${appUrn} is not running`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('not running')) {
        throw err;
      }
      if (err instanceof Error && err.message.includes('not installed')) {
        throw err;
      }
      throw new Error(`App ${appUrn} is not running`);
    }
  }

  /**
   * S-AMB-1.1: Connect to an upstream Streamable HTTP MCP server via the official SDK client.
   */
  private async connectStreamableHttp(appUrn: AppUrn, conn: McpConnection): Promise<McpConnection['tools']> {
    if (!conn.config.url) {
      throw new Error(`No MCP URL configured for ${appUrn}`);
    }

    const url = this.resolveTemplateUrl(conn.config.url, appUrn);
    const headers = await this.buildStreamableHttpHeaders(appUrn, conn);

    if (!conn.httpClient) {
      conn.httpClient = new McpStreamableHttpClient();
    }

    await conn.httpClient.connect({ url, headers, sessionId: conn.sessionId });
    conn.sessionId = conn.httpClient.sessionId;

    const tools = await conn.httpClient.listTools();

    conn.connected = true;
    conn.tools = tools;
    conn.retryCount = 0;

    this.logger.info(`Connected to ${appUrn} MCP server via Streamable HTTP, discovered ${tools.length} tools`);
    return tools;
  }

  private async buildStreamableHttpHeaders(appUrn: AppUrn, conn: McpConnection): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (conn.config.auth?.type === 'bearer' && conn.config.auth.token_env) {
      const token = await this.resolveAuthToken(appUrn, conn.config.auth.token_env);
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }
    return headers;
  }

  /**
   * S-AMB-2.1: Connect via docker exec stdio
   * S-AMB-2.2: Container identified by container field or main service
   */
  private async connectStdio(appUrn: AppUrn, conn: McpConnection): Promise<McpConnection['tools']> {
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

  private async stdioRequest(
    appUrn: AppUrn,
    conn: McpConnection,
    request: { method: string; params: Record<string, unknown> },
    timeoutMs: number,
  ): Promise<unknown> {
    try {
      return await this.stdioRequestOnce(appUrn, conn, request, timeoutMs);
    } catch (err) {
      if (err instanceof StdioSilentExitError) {
        this.logger.warn(`MCP stdio server for ${appUrn} exited silently (early stdin close?) — retrying once`);
        conn.stdioSession?.close();
        conn.stdioSession = undefined;
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
    const session = await this.getOrCreateStdioSession(appUrn, conn);
    return session.request(request.method, request.params, timeoutMs);
  }

  private async getOrCreateStdioSession(appUrn: AppUrn, conn: McpConnection): Promise<McpStdioSession> {
    if (conn.stdioSession?.alive) {
      return conn.stdioSession;
    }
    conn.stdioSession?.close();
    const spec = await this.buildStdioSpawnSpec(appUrn, conn);
    const session = new McpStdioSession(appUrn, spec, (chunk) => {
      this.logger.warn(`MCP stdio stderr (${appUrn}): ${chunk}`);
    });
    conn.stdioSession = session;
    return session;
  }

  private async buildStdioSpawnSpec(appUrn: AppUrn, conn: McpConnection): Promise<StdioSpawnSpec> {
    const launch = conn.config.launch ?? 'container_exec';
    const appEnv = await this.loadAppEnvRecord(appUrn);
    return {
      launch,
      command: conn.config.command ?? [],
      container: conn.config.container ?? this.defaultMainContainerName(appUrn),
      env: appEnv,
    };
  }

  private async loadAppEnvRecord(appUrn: AppUrn): Promise<Record<string, string>> {
    try {
      const appEnv = await this.appFilesManager.getAppEnv(appUrn);
      return Object.fromEntries(this.envUtils.envStringToMap(appEnv.content ?? ''));
    } catch {
      return {};
    }
  }

  /** Compose names containers `<project>-<service>-1`; the Hub's project is `<app>_<store>`. */
  private defaultMainContainerName(appUrn: AppUrn): string {
    const [appName, storeSlug] = appUrn.split(':') as [string, string];
    return `${appName}_${storeSlug}-${appName}-1`;
  }

  private bridgeTool(appUrn: AppUrn, prefix: string, tool: McpConnection['tools'][0]): McpToolDefinition {
    return {
      name: `${prefix}__${tool.name}`,
      // A bridged tool's effect is opaque to the Hub — github-mcp can delete branches, filesystem-mcp
      // can overwrite files — so it takes the same posture as hub_call_app_tool: assume the worst.
      // Honouring the upstream tool's own `annotations.readOnlyHint` would let a read-only key use a
      // well-behaved bridge, but the discovery parser does not carry annotations through today
      // (McpConnection['tools'] holds name/description/inputSchema only), so that is a follow-up.
      access: 'write',
      destructive: true,
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

    // Check if app is still reachable
    try {
      const { app } = await this.appsService.getApp(appUrn);
      if (!app) {
        conn.connected = false;
        return { error: `App ${appUrn} is not installed`, isError: true };
      }
      if (!isHostDockerLaunch(conn.config.launch) && app.status !== 'running') {
        conn.connected = false;
        conn.stdioSession?.close();
        conn.stdioSession = undefined;
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

    if (isStreamableHttpTransport(conn.config.transport)) {
      return this.callViaStreamableHttp(appUrn, conn, toolName, params);
    }

    return this.callViaStdio(appUrn, conn, toolName, params);
  }

  private async callViaStreamableHttp(
    appUrn: AppUrn,
    conn: McpConnection,
    toolName: string,
    params: Record<string, unknown>,
    retried = false,
  ): Promise<unknown> {
    if (!conn.httpClient?.connected) {
      await this.connectStreamableHttp(appUrn, conn);
    }

    try {
      const httpClient = conn.httpClient;
      if (!httpClient) {
        throw new Error('MCP HTTP client unavailable');
      }
      return await httpClient.callTool(toolName, params);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'MCP Streamable HTTP call failed';
      if (!retried && /session|404|not connected/i.test(message)) {
        conn.connected = false;
        conn.sessionId = undefined;
        await conn.httpClient?.close();
        conn.httpClient = undefined;
        await this.connectStreamableHttp(appUrn, conn);
        return this.callViaStreamableHttp(appUrn, conn, toolName, params, true);
      }
      return { error: message, isError: true };
    }
  }

  private async callViaStdio(appUrn: AppUrn, conn: McpConnection, toolName: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.stdioRequest(appUrn, conn, { method: 'tools/call', params: { name: toolName, arguments: params } }, 30000);
    } catch (err) {
      conn.connected = false;
      conn.stdioSession?.close();
      conn.stdioSession = undefined;
      return { error: err instanceof Error ? err.message : 'MCP stdio call failed', isError: true };
    }
  }

  private getOrCreateConnection(appUrn: AppUrn, config: NonNullable<ResolvedAgentConfig['mcp']['config']>): McpConnection {
    const existing = this.connections.get(appUrn);
    if (existing && !this.configMatches(existing.config, config)) {
      this.disconnect(existing);
      this.connections.delete(appUrn);
    }

    let conn = this.connections.get(appUrn);
    if (conn) {
      conn.config = config;
    } else {
      conn = { appUrn, connected: false, tools: [], config, retryCount: 0 };
      this.connections.set(appUrn, conn);
    }
    return conn;
  }

  private configMatches(a: McpConnection['config'], b: McpConnection['config']): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /** Read an auth token from app.env first, then Hub process env. */
  private async resolveAuthToken(appUrn: AppUrn, tokenEnv: string): Promise<string | undefined> {
    try {
      const appEnv = await this.appFilesManager.getAppEnv(appUrn);
      const fromApp = this.envUtils.envStringToMap(appEnv.content ?? '').get(tokenEnv);
      if (fromApp) return fromApp;
    } catch {
      // fall through
    }
    return process.env[tokenEnv];
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
    conn.stdioSession?.close();
    conn.stdioSession = undefined;
    void conn.httpClient?.close();
    conn.httpClient = undefined;
    conn.sessionId = undefined;
    conn.connected = false;
  }

  private resolveTemplateUrl(url: string, appUrn: AppUrn): string {
    const [storeSlug, appName] = appUrn.split(':') as [string, string];
    return url.replace(/\$\{APP_HOST\}/g, `${appName}-${storeSlug}`).replace(/\$\{APP_PORT\}/g, '');
  }
}
