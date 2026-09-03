import { Injectable } from '@nestjs/common';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { HUB_MCP_PROTOCOL_VERSIONS } from './mcp-protocol';
import { LoggerService } from '@/core/logger/logger.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { McpService } from './mcp.service';
import { McpSessionRegistry } from './mcp-session.registry';
import { McpToolRegistry, isPotentiallyDestructive } from './mcp-tool-registry.service';

/** Operator-facing view of a single MCP tool (adds the `destructive` flag for the UI confirm gate,
 *  the read/write `access` so the catalog can show which capability reaches it, and a `category` for
 *  grouping). */
export interface McpAdminToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  destructive: boolean;
  access: 'read' | 'write';
  category: string;
}

/**
 * ENH-MCP-4: business logic behind the session-authed MCP admin surface. Reads the tool registry and
 * session registry for operator visibility, and runs tools server-side (so the browser never holds the
 * agent key).
 *
 * It deliberately owns no appliance-wide MCP settings. The destructive-tool gate used to live here as
 * one switch for every key at once; it is now each key's `capability` (see api-key.capabilities.ts),
 * managed in Settings → Security, so an operator can grant destructive access to one agent without
 * granting it to all of them.
 */
@Injectable()
export class McpAdminService {
  constructor(
    private readonly registry: McpToolRegistry,
    private readonly mcpService: McpService,
    private readonly sessions: McpSessionRegistry,
    private readonly apiKeys: ApiKeyService,
    private readonly logger: LoggerService,
  ) {}

  /** Overall MCP server status for the admin screen. */
  async getStatus() {
    return {
      // MCP_ENABLED gates the module at import time, so it's read-only here (toggle via `cihub mcp`).
      enabled: process.env.MCP_ENABLED !== 'false',
      server: this.mcpService.getServerInfo(),
      protocolVersion: LATEST_PROTOCOL_VERSION,
      protocolVersions: [...HUB_MCP_PROTOCOL_VERSIONS],
      toolCount: this.registry.listTools().length,
      activeSessions: this.sessions.activeSessions,
      // SEC-MCP-8: number of keys accepted by the MCP surface ('mcp' scope, operator + managed).
      activeKeyCount: await this.apiKeys.count('mcp'),
      endpoint: '/api/mcp',
    };
  }

  /**
   * Full tool catalog with descriptions, input schemas, and destructive/access flags.
   *
   * Projected field by field rather than by spreading the MCP wire descriptor. The two shapes now
   * answer different questions — the wire carries `annotations` for a client, this carries flags for
   * an operator screen — and spreading would quietly ship whatever the wire shape gains next in an
   * admin response whose interface does not mention it.
   */
  listTools(): McpAdminToolInfo[] {
    return this.registry.listTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      // A tool with an arg-based predicate (e.g. hub_call_app_api) is flagged destructive here so the
      // UI prompts for confirmation; the registry's predicate still decides per-call at execution.
      destructive: isPotentiallyDestructive(tool),
      access: tool.access,
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
      // 'full' because this caller is not a key: the operator is session-authed, and the thing standing
      // between them and a destructive tool is the confirmation they just gave, not a stored capability.
      const result = await this.registry.callTool(name, args ?? {}, { capability: 'full', allowDestructive: confirmDestructive });
      this.logger.info('MCP admin tool call', name, `${Date.now() - start}ms`, 'ok');
      return { ok: true, result };
    } catch (error) {
      this.logger.warn('MCP admin tool call failed', name, `${Date.now() - start}ms`);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
