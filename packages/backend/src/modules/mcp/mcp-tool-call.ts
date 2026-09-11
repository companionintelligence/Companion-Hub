import { HttpStatus } from '@nestjs/common';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TranslatableError } from '@/common/error/translatable-error';
import type { HubAction } from '@/core/portal/hub-actions';
import type { LifecycleActor } from '@/core/portal/lifecycle-actor';
import type { LoggerService } from '@/core/logger/logger.service';
import type { ApiKeyCapability } from '@/modules/api-keys/api-key.capabilities';
import { formatToolError, formatToolSuccess } from './mcp-error.handler';
import { mcpAdminCallContext, mcpCallContext } from './mcp-call-context';
import { McpToolNotFoundError, McpToolRegistry } from './mcp-tool-registry.service';

/** Capability of the authenticated key for the in-flight MCP request. Fails closed to read-only. */
export function mcpCallerCapability(): ApiKeyCapability {
  return mcpCallContext.getStore()?.capability ?? 'read';
}

/**
 * Who a lifecycle tool acts as for `action`, in the in-flight call: the signed-in person behind an
 * `/api/mcp-admin` run, or the `/api/mcp` key — confined to its own app when it is a managed one.
 *
 * A call that names neither is refused, the way {@link mcpCallerCapability} fails closed. Reading "no
 * key" as an unmanaged key is how the admin runner, which never has one, reached every app with no
 * grant check (CI-Hub#1397).
 */
export function mcpCallerLifecycleActor(action: HubAction): LifecycleActor {
  const actorFor = mcpAdminCallContext.getStore();

  if (actorFor) {
    return actorFor(action);
  }

  const key = mcpCallContext.getStore();

  if (key) {
    return { kind: 'mcp', ownerAppUrn: key.ownerAppUrn };
  }

  throw new TranslatableError('APP_ACTION_GRANT_DENIED', { action }, HttpStatus.FORBIDDEN);
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
