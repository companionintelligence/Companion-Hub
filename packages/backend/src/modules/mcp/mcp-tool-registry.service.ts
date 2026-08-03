import { Injectable } from '@nestjs/common';
import type { ApiKeyCapability } from '@/modules/api-keys/api-key.capabilities';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
  /**
   * Whether the tool reads appliance state or changes it. REQUIRED, and required on purpose: a new
   * tool that forgets to say fails `tsc`, so it can never reach a read-only key by omission. A
   * runtime "is everything classified" test would only catch it after the fact, and only if the test
   * ran.
   *
   * - 'read':  returns information; calling it changes nothing.
   * - 'write': changes appliance state (install, start, stop, reconfigure, pull, cancel).
   *
   * Destructive is not a third value — it is the {@link destructive} flag on top of 'write', because
   * the two answer different questions ("does this mutate?" vs "can this lose data?") and 'read' can
   * never be destructive. Conflating them is the mistake that would let a "non-destructive" key
   * restart every app on the box.
   */
  access: 'read' | 'write';
  /**
   * ENH-MCP-4: human-readable grouping (the tool's provider domain, e.g. 'App Lifecycle',
   * 'Inference & Models') used ONLY to organize the admin Tool-catalog UI. Not part of the MCP wire
   * (the spec's tools/list has no category) — surfaced only via the admin listTools endpoint.
   */
  category?: string;
  /**
   * ISSUE-MCP-2: marks a tool that can cause data loss, delete resources, or change all apps at
   * once (e.g. hub_uninstall_app, hub_reset_app, hub_delete_*, hub_*_all_apps, hub_perform_update).
   * Destructive tools are refused unless destructive calls are explicitly allowed — either a calling
   * key with the 'full' capability, or an operator confirmation on the admin tool runner (which
   * passes `allowDestructive` to {@link McpToolRegistry.callTool}).
   */
  destructive?: boolean;
  /**
   * ISSUE-MCP-2: for a tool whose destructiveness depends on its arguments (hub_call_app_api, where
   * a GET is read-only but a DELETE/PUT/PATCH mutates app data), a predicate evaluated per call.
   * When present it OVERRIDES the static `destructive` flag for the gate decision.
   */
  isDestructive?: (params: Record<string, unknown>) => boolean;
  /**
   * The read/write counterpart of {@link isDestructive}, for the same argument-dependent tools: true
   * when THESE arguments only read. Present so a read-only key keeps the harmless half of such a
   * tool (a GET through the app-API proxy) instead of losing the tool wholesale because its worst
   * case is a write. When present it OVERRIDES the static `access` field for the gate decision.
   */
  isReadOnly?: (params: Record<string, unknown>) => boolean;
}

/** The MCP wire shape for a tool in a `tools/list` response — the public subset of a definition
 *  (no handler/flags). Shared by the SDK server's tools/list handler and the admin catalog so the
 *  two projections can't drift. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * MCP standard annotation hints, so a client can warn its user *before* it calls rather than
   * discovering the refusal afterwards. Matches what CI-Server's MCP surface already emits.
   * `openWorldHint` is deliberately absent: the Hub has no per-tool signal for it, and asserting a
   * hint we cannot back is worse than omitting an optional one.
   */
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
  };
}

/** Project a registered tool into its MCP descriptor (name/description/inputSchema/annotations). */
export function toToolDescriptor(tool: McpToolDefinition): McpToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      // The static view: a tool whose read-ness depends on its arguments (hub_call_app_api) is not
      // advertised as read-only, since its worst case is not.
      readOnlyHint: tool.access === 'read',
      // Same in the other direction — an arg-dependent tool CAN be destructive, so it is flagged.
      destructiveHint: isPotentiallyDestructive(tool),
    },
  };
}

/** True when a tool could be destructive for at least some arguments — the static, params-free view
 *  used for listing and for the admin UI's confirm gate. The per-call decision (which may say no for
 *  these particular arguments) belongs to {@link McpToolRegistry.callTool}. */
export function isPotentiallyDestructive(tool: McpToolDefinition): boolean {
  return Boolean(tool.destructive) || typeof tool.isDestructive === 'function';
}

/**
 * Whether a capability could ever reach this tool — the static view, for `tools/list`. A capability
 * sees only the tools it can actually call, so an agent never burns a turn on a tool that was always
 * going to be refused.
 *
 * "Could ever" is the right test rather than "can right now" because two tools are argument-
 * dependent: hub_call_app_api is readable with a GET and destructive with a DELETE, so it belongs in
 * every capability's list and the real decision happens at call time.
 */
export function isToolVisibleToCapability(tool: McpToolDefinition, capability: ApiKeyCapability): boolean {
  if (capability === 'full') {
    return true;
  }
  if (capability === 'write') {
    // Statically destructive tools are out. An arg-dependent one stays in — some of its calls pass.
    return tool.destructive !== true;
  }
  return tool.access === 'read' || typeof tool.isReadOnly === 'function';
}

/** Options controlling a single {@link McpToolRegistry.callTool} invocation. */
export interface CallToolOptions {
  /**
   * The calling key's capability. Fails closed to 'read' when absent: every real caller passes one
   * (the agent path from the authenticated key, the admin tool runner as 'full' — it is session-
   * authed and gates destructive tools on an operator confirmation instead), so a missing capability
   * means the request context was lost, and the safe reading of "we don't know who is calling" is the
   * smallest authority rather than the largest.
   */
  capability?: ApiKeyCapability;
  /**
   * When true, a destructive tool is permitted for this call regardless of capability. The
   * operator-facing admin tool runner (ENH-MCP-4) sets this after an explicit confirmation; the
   * agent-facing MCP endpoint never sets it (a key's own capability decides).
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

  /** The tools a capability can reach — what `tools/list` returns for a given key. */
  listToolsForCapability(capability: ApiKeyCapability): McpToolDefinition[] {
    return this.listTools().filter((tool) => isToolVisibleToCapability(tool, capability));
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  getTool(name: string): McpToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Invoke a registered tool. Throws {@link McpToolNotFoundError} for an unknown name,
   * {@link DestructiveToolDisabledError} when a destructive tool is called without permission, and
   * {@link WriteToolDeniedError} when a mutating tool is called by a read-only key. Any other error
   * is the tool handler's own failure and propagates to the caller for formatting.
   *
   * ISSUE-MCP-2's guarantee — a leaked key cannot wipe app data by default — now rests on the key's
   * own capability rather than an appliance-wide switch, so it holds per credential.
   */
  async callTool(name: string, params: Record<string, unknown>, opts: CallToolOptions = {}): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new McpToolNotFoundError(name);
    }
    const capability = opts.capability ?? 'read';
    // Per-call predicates (argument-dependent tools) override the static fields.
    const destructive = tool.isDestructive ? tool.isDestructive(params) : Boolean(tool.destructive);
    const readOnly = tool.isReadOnly ? tool.isReadOnly(params) : tool.access === 'read';

    if (destructive && !(opts.allowDestructive ?? capability === 'full')) {
      // Two different refusals wear the same exception. An agent was stopped by its key's capability
      // and needs the level raised; the admin runner was stopped by an operator not confirming, and
      // its caller is already 'full' — telling that operator to "grant the key 'full' capability"
      // names a remedy they have and an actor that isn't involved. `allowDestructive` being set at
      // all is what distinguishes them: only the runner passes it.
      throw new DestructiveToolDisabledError(
        name,
        opts.allowDestructive === undefined ? { reason: 'capability', capability } : { reason: 'unconfirmed' },
      );
    }
    // Checked after the destructive gate so a read-only key calling a destructive tool is told the
    // stronger fact (it is destructive), not just that it mutates.
    if (!readOnly && capability === 'read') {
      throw new WriteToolDeniedError(name);
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
 * ISSUE-MCP-2: a destructive tool was invoked by a key that may not run one. Surfaced to the agent as
 * a tool error (not a crash) with actionable guidance, and logged at warn by the caller. The message
 * names the calling key's capability so the fix is obvious from the error alone — an agent that just
 * reads "disabled" has no way to tell a policy from a bug.
 */
export class DestructiveToolDisabledError extends Error {
  constructor(
    toolName: string,
    cause: { reason: 'capability'; capability: ApiKeyCapability } | { reason: 'unconfirmed' } = {
      reason: 'capability',
      capability: 'read',
    },
  ) {
    super(
      cause.reason === 'unconfirmed'
        ? `Tool '${toolName}' is destructive and was run without confirmation. Confirm the prompt in the Hub UI to run it.`
        : `Tool '${toolName}' is destructive and this API key's capability is '${cause.capability}'. Grant the key the 'full' capability in Settings → Security to allow destructive tools, or run it from the Hub UI with explicit confirmation.`,
    );
    this.name = 'DestructiveToolDisabledError';
  }
}

/** A mutating (non-destructive) tool was invoked by a read-only key. Distinct from
 *  {@link DestructiveToolDisabledError} so the remedy differs: 'write' is enough here, and telling a
 *  caller to ask for 'full' when 'write' would do is how keys end up over-privileged. */
export class WriteToolDeniedError extends Error {
  constructor(toolName: string) {
    super(
      `Tool '${toolName}' changes Hub state and this API key is read-only. Grant the key the 'write' ` +
        'capability in Settings → Security to allow it.',
    );
    this.name = 'WriteToolDeniedError';
  }
}
