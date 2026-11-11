import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppsService } from '@/modules/apps/apps.service';
import { assertMcpCallerMay } from '../mcp-tool-call';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { AgentConfigService, type ResolvedAgentConfig } from '../agents/agent-config.service';
import { SkillResolverService } from '../agents/skill-resolver.service';
import { OpenApiBridgeService, type GeneratedToolInfo } from '../agents/openapi-bridge.service';
import { McpBridgeService, type BridgedToolDetail } from '../agents/mcp-bridge.service';
import { bridgedCallToolResult, markCallToolResult } from '../mcp-call-tool-result';

/** One app tool as `hub_list_app_tools` returns it when asked about that tool alone. */
type AppToolDetail = BridgedToolDetail | (GeneratedToolInfo & { inputSchema: Record<string, unknown> });

@Injectable()
export class AppAgentTools implements OnModuleInit {
  constructor(
    private readonly appsService: AppsService,
    private readonly registry: McpToolRegistry,
    private readonly agentConfigService: AgentConfigService,
    private readonly skillResolver: SkillResolverService,
    private readonly openapiBridge: OpenApiBridgeService,
    private readonly mcpBridge: McpBridgeService,
    private readonly appLifecycleService: AppLifecycleService,
  ) {}

  onModuleInit() {
    this.registry.register({
      category: 'App Agents & Skills',
      name: 'hub_get_app_skill',
      access: 'read',
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
      access: 'read',
      description:
        'List all installed apps that have agent integration (skill, openapi, or mcp). Only includes apps with at least one integration layer.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.listAgentApps(),
    });

    this.registry.register({
      category: 'App Agents & Skills',
      name: 'hub_list_app_tools',
      access: 'read',
      description:
        'List the agent tools an app provides (OpenAPI-generated and MCP-bridged) by name and description. ' +
        "Pass tool with one name to get that tool's inputSchema. For an MCP tool (source mcp) it is the arguments " +
        'hub_call_app_tool takes. An OpenAPI tool (source openapi) is called through hub_call_app_api with the method ' +
        "and path it lists. Its inputSchema names the operation's parameters and request body.",
      inputSchema: {
        type: 'object',
        properties: {
          appUrn: { type: 'string', description: 'App identifier in appName:storeSlug format' },
          tool: {
            type: 'string',
            description: 'Optional. One tool name (bare or prefixed, as listed) to return with its inputSchema instead of the whole list',
          },
        },
        required: ['appUrn'],
      },
      handler: (p) =>
        typeof p.tool === 'string' && p.tool !== ''
          ? this.describeAppTool(p as { appUrn: string; tool: string })
          : this.listAppTools(p as { appUrn: string }),
    });

    this.registry.register({
      category: 'App Agents & Skills',
      name: 'hub_call_app_tool',
      access: 'write',
      // A bridged tool's effect is opaque to the Hub — github-mcp can delete branches, filesystem-mcp
      // can overwrite files. Same posture as mutating hub_call_app_api verbs: gated as destructive.
      // Stated as the static flag rather than an always-true predicate: a predicate would advertise
      // this as argument-dependent, so tools/list would keep offering it to read-only and write keys
      // that can never actually run it.
      destructive: true,
      description:
        "Call a tool on an app's bridged MCP server. Use hub_list_app_tools to discover tool names and " +
        'hub_list_app_tools with tool to read the arguments one of them takes. The Hub forwards the call over ' +
        "the app's declared MCP transport and returns the app's own result content. A failed call comes back " +
        "with isError, plus the tool's inputSchema when the Hub still holds it from the app's server.",
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
      access: 'read',
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

  /*
   * Each tool on one app asks the lifecycle's actor gate first (`assertMcpCallerMay`) — `view` to read
   * about the app, `configure` to call into it, as a mutating hub_call_app_api does — because each one's
   * first step is `AppsService.getApp`, and the lifecycle module depends on `AppsService` (CI-Hub#1397).
   */

  /**
   * S-ASK-1.1: Returns { content, available }
   * S-ASK-1.2: available=false when no SKILL.md
   * S-ASK-1.3: Content has all template variables resolved
   */
  async getAppSkill(params: { appUrn: string }): Promise<{ content: string; available: boolean }> {
    const appUrn = castAppUrn(params.appUrn);
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'view');
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
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'view');
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

  /**
   * One of an app's tools with its inputSchema, for `hub_list_app_tools` given `tool`. The list leaves
   * schemas out so it stays small, which left an agent guessing the arguments of the tool it was about
   * to call (GitHub's list_issues refuses `state: "OPEN"`; it wants "open").
   */
  async describeAppTool(params: { appUrn: string; tool: string }): Promise<{ tool: AppToolDetail }> {
    const appUrn = castAppUrn(params.appUrn);
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'view');
    const { info } = await this.appsService.getApp(appUrn);
    const agentConfig = await this.agentConfigService.getAgentConfig(appUrn, info);

    let unreachable: string | undefined;
    if (agentConfig) {
      // Connects first if nothing has yet, the way the list does (#936).
      unreachable = await this.mcpBridge.discoverTools(appUrn, agentConfig).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      const mcpTool = this.mcpBridge.describeTool(appUrn, params.tool);
      if (mcpTool) {
        return { tool: mcpTool };
      }
      const openApiTool = await this.describeOpenApiTool(appUrn, agentConfig, params.tool);
      if (openApiTool) {
        return { tool: openApiTool };
      }
    }

    throw new Error(
      unreachable
        ? `Could not read ${params.appUrn}'s tools: ${unreachable}`
        : `${params.appUrn} has no tool named ${params.tool}. Call hub_list_app_tools without tool to list them.`,
    );
  }

  /** An OpenAPI-generated tool by its listed name (or the operation part of it), with its inputSchema. */
  private async describeOpenApiTool(appUrn: AppUrn, agentConfig: ResolvedAgentConfig, toolName: string): Promise<AppToolDetail | undefined> {
    // Exactly this app's name for the operation: a suffix match would take `admin__users` for `users`.
    const prefixed = `${appUrn.replace(':', '_')}__${toolName}`;
    const generated = (await this.openapiBridge.generateTools(appUrn, agentConfig)).find((tool) => tool.name === toolName || tool.name === prefixed);
    if (!generated) {
      return undefined;
    }
    // generateTools has just cached the spec, so this reads no file.
    const listed = (await this.openapiBridge.listToolInfo(appUrn, agentConfig)).find((tool) => tool.name === generated.name);

    return listed && { ...listed, inputSchema: generated.inputSchema };
  }

  /**
   * Forward a tool call to an app's bridged MCP server (#936) and return the server's own result: its
   * content items as they are, and `isError` when the server or the bridge refused the call. A refused
   * call also carries the tool's inputSchema, so an agent that passed the wrong arguments can fix them
   * without another lookup.
   */
  async callAppTool(params: { appUrn: string; tool: string; arguments?: Record<string, unknown> }): Promise<unknown> {
    const appUrn = castAppUrn(params.appUrn);
    // An app call: `configure` to a person, and made by a managed app key on any app.
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'configure', { appCall: true });
    const { info } = await this.appsService.getApp(appUrn);
    const agentConfig = await this.agentConfigService.getAgentConfig(appUrn, info);

    if (!agentConfig?.mcp.enabled) {
      return markCallToolResult({ content: [{ type: 'text', text: `App ${params.appUrn} has no MCP server configured` }], isError: true });
    }

    const raw = await this.mcpBridge.callTool(appUrn, agentConfig, params.tool, params.arguments ?? {});
    const result = bridgedCallToolResult(raw);
    if (!result) {
      return raw;
    }
    if (result.isError) {
      const tool = this.mcpBridge.describeTool(appUrn, params.tool);
      if (tool) {
        result.content.push({ type: 'text', text: `${tool.name} takes these arguments (JSON Schema): ${JSON.stringify(tool.inputSchema)}` });
      }
    }
    return markCallToolResult(result);
  }

  /**
   * S-AOA-4.1: Returns raw OpenAPI spec as JSON string
   * S-AOA-4.2: Returns { available: false } when no spec
   */
  async getAppOpenApi(params: { appUrn: string }): Promise<{ spec: string; available: boolean }> {
    const appUrn = castAppUrn(params.appUrn);
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'view');
    const { info } = await this.appsService.getApp(appUrn);
    const agentConfig = await this.agentConfigService.getAgentConfig(appUrn, info);

    if (!agentConfig) {
      return { spec: '', available: false };
    }

    return this.openapiBridge.getRawSpec(appUrn, agentConfig);
  }
}
