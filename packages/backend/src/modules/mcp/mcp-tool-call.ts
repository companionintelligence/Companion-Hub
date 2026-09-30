import { HttpStatus } from '@nestjs/common';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppUrn } from '@ci-hub/common/types';
import { TranslatableError } from '@/common/error/translatable-error';
import type { HubAction } from '@/core/portal/hub-actions';
import type { ActorCheckContext, LifecycleActor } from '@/core/portal/lifecycle-actor';
import type { LoggerService } from '@/core/logger/logger.service';
import type { ApiKeyCapability } from '@/modules/api-keys/api-key.capabilities';
import type { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { formatToolError, formatToolSuccess } from './mcp-error.handler';
import { mcpAdminCallContext, mcpCallContext } from './mcp-call-context';
import { McpToolNotFoundError, McpToolRegistry } from './mcp-tool-registry.service';

/** Capability of the authenticated key for the in-flight MCP request. Fails closed to read-only. */
export function mcpCallerCapability(): ApiKeyCapability {
  return mcpCallContext.getStore()?.capability ?? 'read';
}

/**
 * Whether the in-flight tool call is a signed-in operator's run from the Hub UI's tool runner
 * (`/api/mcp-admin`), rather than an agent's key. Fails closed: anything that did not come through
 * that route — a key of any capability, or a call whose context was lost — is not an operator.
 */
export function mcpCallerIsOperator(): boolean {
  return mcpAdminCallContext.getStore() !== undefined;
}

/**
 * Who a lifecycle tool acts as for `action`, in the in-flight call: the signed-in person behind an
 * `/api/mcp-admin` run, or the `/api/mcp` key — which, when it is a managed one, may do anything on its
 * own app and on the others as far as its capability reaches (`AppLifecycleService.actorMay`), and acts
 * as the person who created it when it is not. The capability is the one this request's key was
 * resolved with, so a change made in Settings applies from the next call.
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
    return { kind: 'mcp', ownerAppUrn: key.ownerAppUrn, createdByUserId: key.createdByUserId, capability: key.capability };
  }

  throw new TranslatableError('APP_ACTION_GRANT_DENIED', { action }, HttpStatus.FORBIDDEN);
}

/**
 * Refuse the in-flight caller `action` on `appUrn` unless the lifecycle's actor gate admits it.
 *
 * For a tool on one app whose own service cannot ask that gate: a service the lifecycle module
 * itself depends on, or one serving app routes that assert no grant, where a required actor would
 * change what those routes allow. Such a tool asks here, first, before it reads or changes anything.
 * `context` marks what the check is for where the verb cannot say, as `assertActorMay` takes it.
 */
export async function assertMcpCallerMay(
  lifecycle: Pick<AppLifecycleService, 'assertActorMay'>,
  appUrn: AppUrn,
  action: HubAction,
  context?: ActorCheckContext,
): Promise<void> {
  await lifecycle.assertActorMay(mcpCallerLifecycleActor(action), appUrn, action, context);
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
