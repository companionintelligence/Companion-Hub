import { Injectable, type OnModuleInit } from '@nestjs/common';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { AppsService } from '@/modules/apps/apps.service';
import type { AgentOpenApiAuth } from '@ci-hub/common/schemas';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { AgentConfigService } from '../agents/agent-config.service';
import { ApiProxyService } from '../agents/api-proxy.service';

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
      // ISSUE-MCP-2: this proxy can mutate app data. A read-only GET/HEAD stays ungated, but any
      // mutating verb (POST/PUT/PATCH/DELETE) is treated as destructive so it requires
      // MCP_ALLOW_DESTRUCTIVE (agent) or an operator confirmation (admin runner) — otherwise a
      // leaked key could DELETE arbitrary app data despite the safe default.
      isDestructive: (p) => !['GET', 'HEAD'].includes(String((p as { method?: string }).method ?? '').toUpperCase()),
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

    // Try to get auth config from agent config
    let auth: AgentOpenApiAuth | undefined;
    try {
      const { info } = await this.appsService.getApp(appUrn);
      const agentConfig = await this.agentConfigService.getAgentConfig(appUrn, info);
      auth = agentConfig?.openapi?.config?.auth;
    } catch {
      // S-APX-1.3: Still works without agent config
    }

    return this.apiProxy.proxyRequest(appUrn, {
      method: params.method,
      path: params.path,
      body: params.body,
      headers: params.headers,
      queryParams: params.queryParams,
      auth,
    });
  }
}
