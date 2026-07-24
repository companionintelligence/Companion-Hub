import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { AppsService } from '@/modules/apps/apps.service';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { AgentConfigService } from '../agents/agent-config.service';
import { SkillResolverService } from '../agents/skill-resolver.service';
import { OpenApiBridgeService } from '../agents/openapi-bridge.service';
import { McpBridgeService } from '../agents/mcp-bridge.service';

@Injectable()
export class AppAgentTools implements OnModuleInit {
  constructor(
    private readonly appsService: AppsService,
    private readonly registry: McpToolRegistry,
    private readonly agentConfigService: AgentConfigService,
    private readonly skillResolver: SkillResolverService,
    private readonly openapiBridge: OpenApiBridgeService,
    private readonly mcpBridge: McpBridgeService,
  ) {}

  onModuleInit() {
    this.registry.register({
      category: 'App Agents & Skills',
      name: 'hub_get_app_skill',
      description: 'Get the resolved SKILL.md agent skill description for an app. Returns the content with template variables resolved.',
      inputSchema: {
        type: 'object',
        properties: {
          appUrn: { type: 'string', description: 'App identifier in appName:storeSlug format (e.g. nextcloud:ci-store)' },
        },
        required: ['appUrn'],
      },
      handler: (p) => this.getAppSkill(p as { appUrn: string }),
    });

    this.registry.register({
      category: 'App Agents & Skills',
      name: 'hub_list_agent_apps',
      description:
        'List all installed apps that have agent integration (skill, openapi, or mcp). Only includes apps with at least one integration layer.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.listAgentApps(),
    });

    this.registry.register({
      category: 'App Agents & Skills',
      name: 'hub_list_app_tools',
      description: 'List all agent tools provided by a specific app, including OpenAPI-generated tools and MCP-bridged tools.',
      inputSchema: {
        type: 'object',
        properties: {
          appUrn: { type: 'string', description: 'App identifier in appName:storeSlug format' },
        },
        required: ['appUrn'],
      },
      handler: (p) => this.listAppTools(p as { appUrn: string }),
    });

    this.registry.register({
      category: 'App Agents & Skills',
      name: 'hub_call_app_tool',
      // A bridged tool's effect is opaque to the Hub — github-mcp can delete branches, filesystem-mcp
      // can overwrite files. Same posture as mutating hub_call_app_api verbs: gated as destructive.
      isDestructive: () => true,
      description:
        "Call a tool on an app's bridged MCP server. Use hub_list_app_tools to discover tool names. " +
        'The Hub forwards the call to the app container over its declared MCP transport and returns the result.',
      inputSchema: {
        type: 'object',
        properties: {
          appUrn: { type: 'string', description: 'App identifier in appName:storeSlug format' },
          tool: { type: 'string', description: 'Tool name (bare or prefixed form from hub_list_app_tools)' },
          arguments: { type: 'object', description: 'Tool arguments', additionalProperties: true },
        },
        required: ['appUrn', 'tool'],
      },
      handler: (p) => this.callAppTool(p as { appUrn: string; tool: string; arguments?: Record<string, unknown> }),
    });

    this.registry.register({
      category: 'App Agents & Skills',
      name: 'hub_get_app_openapi',
      description: 'Get the raw OpenAPI spec for an app as a JSON string.',
      inputSchema: {
        type: 'object',
        properties: {
          appUrn: { type: 'string', description: 'App identifier in appName:storeSlug format' },
        },
        required: ['appUrn'],
      },
      handler: (p) => this.getAppOpenApi(p as { appUrn: string }),
    });
  }

  /**
   * S-ASK-1.1: Returns { content, available }
   * S-ASK-1.2: available=false when no SKILL.md
   * S-ASK-1.3: Content has all template variables resolved
   */
  async getAppSkill(params: { appUrn: string }): Promise<{ content: string; available: boolean }> {
    const appUrn = castAppUrn(params.appUrn);
    const { info } = await this.appsService.getApp(appUrn);
    const agentConfig = await this.agentConfigService.getAgentConfig(appUrn, info);
    return this.skillResolver.getSkillContent(appUrn, agentConfig);
  }

  /**
   * S-ASK-2.1: Returns apps array with agent integration info
   * S-ASK-2.2: Only apps with at least one agent layer
   */
  async listAgentApps(): Promise<{
    apps: Array<{ appUrn: string; name: string; hasSkill: boolean; hasOpenApi: boolean; hasMcp: boolean }>;
  }> {
    const installedApps = await this.appsService.getInstalledApps();
    const agentApps: Array<{ appUrn: string; name: string; hasSkill: boolean; hasOpenApi: boolean; hasMcp: boolean }> = [];

    for (const { info } of installedApps) {
      const appUrn = info.urn as AppUrn;
      const summary = await this.agentConfigService.getAgentSummary(appUrn, info);
      if (summary) {
        agentApps.push({
          appUrn: info.urn,
          name: info.name,
          ...summary,
        });
      }
    }

    return { apps: agentApps };
  }

  /**
   * S-AOA-5.1: Returns all tools for an app (OpenAPI + MCP)
   * S-AOA-5.2: Each tool includes { name, description, source }
   */
  async listAppTools(params: { appUrn: string }): Promise<{
    tools: Array<{ name: string; description: string; source: 'openapi' | 'mcp' }>;
  }> {
    const appUrn = castAppUrn(params.appUrn);
    const { info } = await this.appsService.getApp(appUrn);
    const agentConfig = await this.agentConfigService.getAgentConfig(appUrn, info);

    if (!agentConfig) {
      return { tools: [] };
    }

    const openapiTools = await this.openapiBridge.listToolInfo(appUrn, agentConfig);
    // Connect-and-discover on demand (#936): the bridge is lazy, so without this a
    // fresh Hub always answered with an empty MCP tool list.
    const mcpTools = await this.mcpBridge.discoverTools(appUrn, agentConfig).catch(() => this.mcpBridge.listToolInfo(appUrn));

    return {
      tools: [...openapiTools, ...mcpTools],
    };
  }

  /** Forward a tool call to an app's bridged MCP server (#936). */
  async callAppTool(params: { appUrn: string; tool: string; arguments?: Record<string, unknown> }): Promise<unknown> {
    const appUrn = castAppUrn(params.appUrn);
    const { info } = await this.appsService.getApp(appUrn);
    const agentConfig = await this.agentConfigService.getAgentConfig(appUrn, info);

    if (!agentConfig?.mcp.enabled) {
      return { error: `App ${params.appUrn} has no MCP server configured`, isError: true };
    }

    return this.mcpBridge.callTool(appUrn, agentConfig, params.tool, params.arguments ?? {});
  }

  /**
   * S-AOA-4.1: Returns raw OpenAPI spec as JSON string
   * S-AOA-4.2: Returns { available: false } when no spec
   */
  async getAppOpenApi(params: { appUrn: string }): Promise<{ spec: string; available: boolean }> {
    const appUrn = castAppUrn(params.appUrn);
    const { info } = await this.appsService.getApp(appUrn);
    const agentConfig = await this.agentConfigService.getAgentConfig(appUrn, info);

    if (!agentConfig) {
      return { spec: '', available: false };
    }

    return this.openapiBridge.getRawSpec(appUrn, agentConfig);
  }
}
