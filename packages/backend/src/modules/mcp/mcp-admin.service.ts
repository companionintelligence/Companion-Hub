import { Injectable } from '@nestjs/common';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import type { ApiKeyInfo } from '@/modules/api-keys/api-key.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { ApiKeyAdminService } from '@/modules/api-keys/api-key-admin.service';
import { McpService } from './mcp.service';
import { McpSessionRegistry } from './mcp-session.registry';
import { McpToolRegistry, toToolDescriptor } from './mcp-tool-registry.service';

/** Operator-facing view of a single MCP tool (adds the `destructive` flag for the UI confirm gate
 *  and a `category` for grouping the catalog). */
export interface McpAdminToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  destructive: boolean;
  category: string;
}

/**
 * ENH-MCP-4: business logic behind the session-authed MCP admin surface. Reads the tool registry and
 * session registry for operator visibility, runs tools server-side (so the browser never holds the
 * agent key), and manages the runtime-effective settings (destructive gate, key rotation) — persisted
 * to settings.json AND applied to process.env immediately so they take effect without a restart.
 */
@Injectable()
export class McpAdminService {
  constructor(
    private readonly registry: McpToolRegistry,
    private readonly mcpService: McpService,
    private readonly sessions: McpSessionRegistry,
    private readonly configuration: ConfigurationService,
    private readonly apiKeys: ApiKeyService,
    private readonly apiKeyAdmin: ApiKeyAdminService,
    private readonly logger: LoggerService,
  ) {}

  /** Overall MCP server status for the admin screen. */
  async getStatus() {
    return {
      // MCP_ENABLED gates the module at import time, so it's read-only here (toggle via `cihub mcp`).
      enabled: process.env.MCP_ENABLED !== 'false',
      server: this.mcpService.getServerInfo(),
      protocolVersion: LATEST_PROTOCOL_VERSION,
      toolCount: this.registry.listTools().length,
      activeSessions: this.sessions.activeSessions,
      destructiveAllowed: McpToolRegistry.destructiveAllowedByEnv(),
      // SEC-MCP-8: number of keys accepted by the MCP surface ('mcp' scope, operator + managed).
      activeKeyCount: await this.apiKeys.count('mcp'),
      endpoint: '/api/mcp',
    };
  }

  /** Full tool catalog with descriptions, input schemas, and destructive flags. */
  listTools(): McpAdminToolInfo[] {
    return this.registry.listTools().map((tool) => ({
      ...toToolDescriptor(tool),
      // A tool with an arg-based predicate (e.g. hub_call_app_api) is flagged destructive here so the
      // UI prompts for confirmation; the registry's predicate still decides per-call at execution.
      destructive: Boolean(tool.destructive) || typeof tool.isDestructive === 'function',
      // Grouping for the catalog UI; bridged/untagged tools fall back to 'Other'.
      category: tool.category ?? 'Other',
    }));
  }

  /**
   * Run a tool on the operator's behalf. Destructive tools require an explicit `confirmDestructive`
   * from the UI. Errors (including a blocked destructive tool) are returned as structured results so
   * the runner can show them inline rather than surfacing a 500.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> | undefined,
    confirmDestructive: boolean,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const start = Date.now();
    try {
      const result = await this.registry.callTool(name, args ?? {}, { allowDestructive: confirmDestructive });
      this.logger.info('MCP admin tool call', name, `${Date.now() - start}ms`, 'ok');
      return { ok: true, result };
    } catch (error) {
      this.logger.warn('MCP admin tool call failed', name, `${Date.now() - start}ms`);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Enable/disable destructive MCP tools. Persisted to settings.json (survives restart) and applied
   * to process.env immediately — the tool registry reads MCP_ALLOW_DESTRUCTIVE per call, so the
   * change is live with no restart.
   */
  async setDestructiveAllowed(allow: boolean): Promise<{ destructiveAllowed: boolean }> {
    // Disk-only persistence: never routed through the in-memory userSettings that /app-context
    // returns (see ConfigurationService.persistMcpSettings). Applied live via process.env.
    await this.configuration.persistMcpSettings({ mcpAllowDestructive: allow });
    process.env.MCP_ALLOW_DESTRUCTIVE = allow ? 'true' : 'false';
    this.logger.info('MCP admin: destructive tools', allow ? 'enabled' : 'disabled');
    return { destructiveAllowed: allow };
  }

  /**
   * Transitional delegates: key management moved to the hub-wide surface
   * (`/api/api-keys`, {@link ApiKeyAdminService}) once keys grew beyond the MCP
   * scope. These keep the old `/api/mcp-admin/keys` routes working for one
   * release so a not-yet-refreshed frontend build doesn't lose key management.
   */
  async listKeys(): Promise<ApiKeyInfo[]> {
    return this.apiKeyAdmin.listKeys();
  }

  async createKey(name: string): Promise<ApiKeyInfo & { key: string }> {
    return this.apiKeyAdmin.createKey(name);
  }

  async revokeKey(id: number): Promise<{ revoked: boolean }> {
    return this.apiKeyAdmin.revokeKey(id);
  }
}
