import { createHash } from 'node:crypto';
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
import { McpServerError, McpStdioSession, StdioSilentExitError, type StdioSpawnSpec } from './mcp-stdio-session';

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
  /** Hash of the spawn spec (command and app.env) the stdio process was started with. */
  stdioSpecKey?: string;
  /**
   * Set by disconnect (uninstall, a config change, shutdown). The connection is out of the map by
   * then, so work still in flight for it must not start a process nothing would stop.
   */
  dropped?: boolean;
}

/** Hashed so the connection doesn't keep a second copy of the app's secrets. */
const stdioSpecKey = (spec: StdioSpawnSpec): string => createHash('sha256').update(JSON.stringify(spec)).digest('hex');

/** Legacy `sse` alias and canonical `streamable-http` both mean Streamable HTTP transport. */
const isStreamableHttpTransport = (transport: string): boolean => transport === 'streamable-http' || transport === 'sse';

const isHostDockerLaunch = (launch: string | undefined): boolean => launch === 'host_docker';

/** What an app's bridged tool names start with: `<app>_<store>__`. */
const toolNamePrefix = (appUrn: AppUrn): string => `${appUrn.replace(':', '_')}__`;

/** A tool name as the app's server knows it, from the bare name or the prefixed one the list shows. */
const bareToolName = (appUrn: AppUrn, toolName: string): string => {
  const prefix = toolNamePrefix(appUrn);
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
};

export interface BridgedToolInfo {
  name: string;
  description: string;
  source: 'mcp';
}

export interface BridgedToolDetail extends BridgedToolInfo {
  inputSchema: Record<string, unknown>;
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
    return this.callBridgedTool(appUrn, bareToolName(appUrn, toolName), params);
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
   * One bridged tool with its input schema, by bare or prefixed name, from what the app's server
   * reported when the bridge connected. The list above leaves schemas out to stay small (GitHub's
   * server has 67 tools); this is how a caller reads the arguments of the one tool it means to call.
   * `undefined` when the bridge isn't connected or the server has no such tool.
   */
  describeTool(appUrn: AppUrn, toolName: string): BridgedToolDetail | undefined {
    const conn = this.connections.get(appUrn);
    if (!conn?.connected) return undefined;

    const bareName = bareToolName(appUrn, toolName);
    const tool = conn.tools.find((candidate) => candidate.name === bareName);

    // A stdio server's tools/list goes in unchecked, so a tool without a schema gets the default the
    // Streamable HTTP client gives one.
    return (
      tool && {
        name: `${toolNamePrefix(appUrn)}${tool.name}`,
        description: tool.description,
        source: 'mcp',
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      }
    );
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
      if (!app || app.status === 'uninstalling') {
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
    try {
      return await session.request(request.method, request.params, timeoutMs);
    } catch (err) {
      // Drop only the session that failed. A changed app.env may have replaced it while this request
      // was in flight. Closing the replacement would fail the request that started it.
      if (!(err instanceof McpServerError) && conn.stdioSession === session) {
        session.close();
        conn.stdioSession = undefined;
      }
      throw err;
    }
  }

  private async getOrCreateStdioSession(appUrn: AppUrn, conn: McpConnection): Promise<McpStdioSession> {
    // Built on every request: a process keeps the environment it started with, so a token changed in
    // the app's settings only reaches the server through a new process.
    const spec = await this.buildStdioSpawnSpec(appUrn, conn);
    const specKey = stdioSpecKey(spec);
    // An empty read (app.env missing, or caught mid-write) says nothing about the token, so it
    // doesn't restart a server that is up.
    const envUnknown = Object.keys(spec.env ?? {}).length === 0;
    if (conn.stdioSession?.alive && (conn.stdioSpecKey === specKey || envUnknown)) {
      return conn.stdioSession;
    }
    conn.stdioSession?.close();
    conn.stdioSession = undefined;
    if (conn.dropped) {
      throw new Error(`MCP connection for ${appUrn} was closed`);
    }
    const session = new McpStdioSession(appUrn, spec, (chunk) => {
      this.logger.warn(`MCP stdio stderr (${appUrn}): ${chunk}`);
    });
    conn.stdioSession = session;
    conn.stdioSpecKey = specKey;
    return session;
  }

  private async buildStdioSpawnSpec(appUrn: AppUrn, conn: McpConnection): Promise<StdioSpawnSpec> {
    const launch = conn.config.launch ?? 'container_exec';
    // Only a host_docker process gets app.env. A `docker exec` runs with the container's own
    // environment, so a change to app.env must not restart it.
    const appEnv = launch === 'host_docker' ? await this.loadAppEnvRecord(appUrn) : {};
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
      if (!app || app.status === 'uninstalling') {
        // Uninstall drops the connection itself. This covers a server that outlived the app anyway. It
        // also refuses a call made while the uninstall runs, which would start one after the drop.
        this.dropApp(appUrn);
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
      // The server answered with an error (a 422 from GitHub, a bad argument): it is working, and
      // restarting it would only cost the next call a fresh `docker run`.
      if (err instanceof McpServerError) {
        return { error: err.message, isError: true };
      }
      // stdioRequestOnce has already dropped the session that failed.
      conn.connected = false;
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
    if (conn.retryTimer || conn.dropped) return;

    const delay = Math.min(1000 * 2 ** conn.retryCount, 30000);
    conn.retryCount++;

    conn.retryTimer = setTimeout(() => {
      conn.retryTimer = undefined;
      if (conn.dropped) return;
      this.connectAndDiscover(appUrn, conn).catch((err) => {
        this.logger.warn(`MCP retry failed for ${appUrn}: ${err instanceof Error ? err.message : 'Unknown'}`);
      });
    }, delay);
  }

  /**
   * Forget an app's MCP connection: stop its server and the tools it advertised. Uninstall calls
   * this. A host_docker server is a `docker run` the bridge started itself, outside the app's compose
   * project. `compose down` never reaches it and it holds the app's credentials in its environment.
   */
  dropApp(appUrn: AppUrn): void {
    const conn = this.connections.get(appUrn);
    if (!conn) return;
    this.disconnect(conn);
    conn.tools = [];
    this.connections.delete(appUrn);
  }

  /** Every caller removes the connection from the map right after, so it is closed for good. */
  private disconnect(conn: McpConnection): void {
    conn.dropped = true;
    if (conn.retryTimer) {
      clearTimeout(conn.retryTimer);
      conn.retryTimer = undefined;
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
