import { Injectable, type OnModuleInit } from '@nestjs/common';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { AppsService } from '@/modules/apps/apps.service';
import type { AgentOpenApiAuth } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { appApiAction, isReadOnlyHttpRequest } from '../http-method-access';
import { mcpCallerLifecycleActor } from '../mcp-tool-call';
import { AgentConfigService } from '../agents/agent-config.service';
import { ApiProxyService } from '../agents/api-proxy.service';

/**
 * Whether a proxied request only reads. One predicate feeds both the destructive gate and the
 * read/write gate, so the two can never disagree about the same call — a request that is "not
 * destructive" is exactly a request that is "read-only" here.
 *
 * The decision is shared with the proxy's actor gate and, for the verb list, the OpenAPI bridge (see
 * http-method-access.ts). A missing or unrecognised method counts as mutating: the schema requires
 * `method`, so its absence means the call is malformed, and a malformed call must not be handed the
 * safest classification. So does a read-only method carrying an override that asks the app to run
 * another one.
 */
function isReadOnlyRequest(params: Record<string, unknown>): boolean {
  return isReadOnlyHttpRequest({ method: params.method, path: params.path, headers: params.headers, queryParams: params.queryParams });
}

@Injectable()
export class AppApiProxyTools implements OnModuleInit {
  constructor(
    private readonly appsService: AppsService,
    private readonly registry: McpToolRegistry,
    private readonly agentConfigService: AgentConfigService,
    private readonly apiProxy: ApiProxyService,
  ) {}

  onModuleInit() {
    this.registry.register({
      category: 'App API Proxy',
      name: 'hub_call_app_api',
      // 'write' is the static worst case (a DELETE), which is what tools/list and the annotations
      // advertise. The real verdict is per call: this is the one tool whose authority genuinely
      // depends on its arguments, so both axes carry a predicate.
      access: 'write',
      // ISSUE-MCP-2: this proxy can mutate app data. Any mutating verb (POST/PUT/PATCH/DELETE) is
      // treated as destructive so it requires a 'full'-capability key (agent) or an operator
      // confirmation (admin runner) — otherwise a leaked key could DELETE arbitrary app data.
      isDestructive: (p) => !isReadOnlyRequest(p),
      // ...and a GET/HEAD only reads, so a read-only key keeps the half of this tool that is safe
      // rather than losing the tool entirely because its worst case is a write.
      isReadOnly: (p) => isReadOnlyRequest(p),
      description:
        "Call an app's API endpoint directly. Acts as an HTTP proxy — the Hub makes the request to the app container and returns the response. " +
        "Useful when generated OpenAPI tools aren't sufficient or when the app has no OpenAPI spec.",
      inputSchema: {
        type: 'object',
        properties: {
          appUrn: { type: 'string', description: 'App identifier in appName:storeSlug format (e.g. nextcloud:ci-store)' },
          method: { type: 'string', description: 'HTTP method (GET, POST, PUT, DELETE, PATCH)', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
          path: { type: 'string', description: 'API path (e.g. /api/v1/users)' },
          body: { type: 'object', description: 'Request body (for POST/PUT/PATCH)', additionalProperties: true },
          headers: { type: 'object', description: 'Additional HTTP headers', additionalProperties: { type: 'string' } },
          queryParams: { type: 'object', description: 'Query string parameters', additionalProperties: { type: 'string' } },
        },
        required: ['appUrn', 'method', 'path'],
      },
      handler: (p) =>
        this.callAppApi(
          p as {
            appUrn: string;
            method: string;
            path: string;
            body?: Record<string, unknown>;
            headers?: Record<string, string>;
            queryParams?: Record<string, string>;
          },
        ),
    });
  }

  /**
   * S-APX-1.1: Makes HTTP request to app container, returns response
   * S-APX-1.2: Injects auth from OpenAPI config if available
   * S-APX-1.3: Works even without agent config using known host:port
   * S-APX-1.4: Truncates responses over 100KB
   */
  async callAppApi(params: {
    appUrn: string;
    method: string;
    path: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    queryParams?: Record<string, string>;
  }): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const appUrn = castAppUrn(params.appUrn);
    // Named first, so a call with nobody behind it is refused before anything else. The proxy asks the
    // lifecycle's actor gate with it, for the verb this request takes, and only then looks the app's
    // auth up — so a caller the gate refuses reads nothing of the app (CI-Hub#1397).
    const actor = mcpCallerLifecycleActor(appApiAction(params));

    return this.apiProxy.proxyRequest(appUrn, {
      method: params.method,
      path: params.path,
      body: params.body,
      headers: params.headers,
      queryParams: params.queryParams,
      auth: () => this.resolveAuth(appUrn),
      actor,
    });
  }

  /** The auth the app's agent config points the Hub at (S-APX-1.2), or none when there is no agent config. */
  private async resolveAuth(appUrn: AppUrn): Promise<AgentOpenApiAuth | undefined> {
    try {
      const { info } = await this.appsService.getApp(appUrn);
      const agentConfig = await this.agentConfigService.getAgentConfig(appUrn, info);
      return agentConfig?.openapi?.config?.auth;
    } catch {
      // S-APX-1.3: Still works without agent config
      return undefined;
    }
  }
}
