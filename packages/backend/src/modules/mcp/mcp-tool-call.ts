import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { LoggerService } from '@/core/logger/logger.service';
import type { ApiKeyCapability } from '@/modules/api-keys/api-key.capabilities';
import { formatToolError, formatToolSuccess } from './mcp-error.handler';
import { mcpCallContext } from './mcp-call-context';
import { McpToolNotFoundError, McpToolRegistry } from './mcp-tool-registry.service';

/** Capability of the authenticated key for the in-flight MCP request. Fails closed to read-only. */
export function mcpCallerCapability(): ApiKeyCapability {
  return mcpCallContext.getStore()?.capability ?? 'read';
}

/** The app a managed key belongs to, for the in-flight MCP request; `null` for any other key. */
export function mcpCallerOwnerAppUrn(): string | null {
  return mcpCallContext.getStore()?.ownerAppUrn ?? null;
}

/** Shared tools/call path for v1 and v2 Hub MCP servers. */
export async function invokeRegistryTool(
  registry: McpToolRegistry,
  logger: LoggerService,
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<CallToolResult> {
  const start = Date.now();
  try {
    const result = await registry.callTool(toolName, toolArgs, { capability: mcpCallerCapability() });
    logger.info('MCP tool call', toolName, `${Date.now() - start}ms`, 'ok');
    return formatToolSuccess(result) as CallToolResult;
  } catch (error) {
    const durationMs = Date.now() - start;
    if (error instanceof McpToolNotFoundError) {
      logger.warn('MCP tool call rejected (unknown tool)', toolName, `${durationMs}ms`);
      throw new McpError(ErrorCode.InvalidParams, error.message);
    }
    logger.warn('MCP tool call failed', toolName, `${durationMs}ms`);
    const appUrn = toolArgs.appUrn as string | undefined;
    return formatToolError(error, appUrn) as CallToolResult;
  }
}
