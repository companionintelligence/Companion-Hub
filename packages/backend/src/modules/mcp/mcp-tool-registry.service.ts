import { Injectable } from '@nestjs/common';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
  /**
   * ISSUE-MCP-2: marks a tool that can cause data loss, delete resources, or change all apps at
   * once (e.g. hub_uninstall_app, hub_reset_app, hub_delete_*, hub_*_all_apps, hub_perform_update).
   * Destructive tools are refused unless destructive calls are explicitly allowed — either the
   * MCP_ALLOW_DESTRUCTIVE env for the agent-facing endpoint, or an operator confirmation on the
   * admin tool runner (which passes `allowDestructive` to {@link McpToolRegistry.callTool}).
   */
  destructive?: boolean;
  /**
   * ISSUE-MCP-2: for tools whose destructiveness depends on their arguments (e.g. hub_call_app_api,
   * where a GET is read-only but a DELETE/PUT/PATCH mutates app data), a predicate evaluated per call.
   * When present it OVERRIDES the static `destructive` flag for the gate decision.
   */
  isDestructive?: (params: Record<string, unknown>) => boolean;
}

/** Options controlling a single {@link McpToolRegistry.callTool} invocation. */
export interface CallToolOptions {
  /**
   * When true, a destructive tool is permitted for this call regardless of the MCP_ALLOW_DESTRUCTIVE
   * env. The operator-facing admin tool runner (ENH-MCP-4) sets this after an explicit confirmation;
   * the agent-facing MCP endpoint never sets it (it relies on the env default).
   */
  allowDestructive?: boolean;
}

@Injectable()
export class McpToolRegistry {
  private tools = new Map<string, McpToolDefinition>();

  /**
   * Register a tool. Names are globally unique across all tool providers; a duplicate name is a
   * programming error (two providers claiming the same tool) and throws at boot.
   */
  register(tool: McpToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  listTools(): McpToolDefinition[] {
    return Array.from(this.tools.values());
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  getTool(name: string): McpToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * True when destructive tools may run on the agent-facing endpoint. ISSUE-MCP-2: destructive tools
   * are opt-in via MCP_ALLOW_DESTRUCTIVE=true so a single leaked API key cannot wipe app data by
   * default. Read from the environment on each call so the admin "settings" toggle takes effect
   * without a code path caching a stale value.
   */
  static destructiveAllowedByEnv(): boolean {
    return process.env.MCP_ALLOW_DESTRUCTIVE === 'true';
  }

  /**
   * Invoke a registered tool. Throws {@link McpToolNotFoundError} for an unknown name and
   * {@link DestructiveToolDisabledError} when a destructive tool is called without permission
   * (neither MCP_ALLOW_DESTRUCTIVE nor an explicit `opts.allowDestructive`). Any other error is the
   * tool handler's own failure and propagates to the caller for formatting.
   */
  async callTool(name: string, params: Record<string, unknown>, opts: CallToolOptions = {}): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new McpToolNotFoundError(name);
    }
    // A per-call predicate (arg-dependent destructiveness) overrides the static flag.
    const destructive = tool.isDestructive ? tool.isDestructive(params) : Boolean(tool.destructive);
    if (destructive) {
      const allowed = opts.allowDestructive ?? McpToolRegistry.destructiveAllowedByEnv();
      if (!allowed) {
        throw new DestructiveToolDisabledError(name);
      }
    }
    return tool.handler(params);
  }
}

/** Unknown tool name — maps to the JSON-RPC "invalid params" code (-32602) at the transport layer. */
export class McpToolNotFoundError extends Error {
  public readonly code = -32602;
  constructor(toolName: string) {
    super(`Unknown tool: ${toolName}`);
    this.name = 'McpToolNotFoundError';
  }
}

/**
 * ISSUE-MCP-2: a destructive tool was invoked while destructive calls are disabled. Surfaced to the
 * agent as a tool error (not a crash) with actionable guidance, and logged at warn by the caller.
 */
export class DestructiveToolDisabledError extends Error {
  constructor(toolName: string) {
    super(
      `Tool '${toolName}' is destructive and is disabled. Set MCP_ALLOW_DESTRUCTIVE=true on the Hub ` +
        'to allow destructive tools over MCP, or run it from the Hub UI with explicit confirmation.',
    );
    this.name = 'DestructiveToolDisabledError';
  }
}
