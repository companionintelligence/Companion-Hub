import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import type { AppUrn } from '@ci-hub/common/types';
import type { AgentConfig, AgentMcpConfig, AppInfo } from '@ci-hub/common/schemas';

export interface ResolvedAgentConfig {
  skill: { enabled: boolean; content: string | null; inline: boolean };
  openapi: { enabled: boolean; specPath: string | null; config: NonNullable<AgentConfig>['openapi'] | null };
  mcp: { enabled: boolean; config: NonNullable<AgentConfig>['mcp'] | null };
}

@Injectable()
export class AgentConfigService {
  constructor(
    private readonly appFilesManager: AppFilesManager,
    private readonly filesystem: FilesystemService,
    readonly _logger: LoggerService,
  ) {}

  /**
   * Load and resolve the agent configuration for an app.
   * Implements ACL-1: loads from config.json agents field
   * Implements ACL-1.2: auto-enables skill if agents/SKILL.md exists but no agents field
   * Implements ACL-1.4: returns null when no agents field and no agents/ directory
   */
  async getAgentConfig(appUrn: AppUrn, appInfo: AppInfo): Promise<ResolvedAgentConfig | null> {
    const { appInstalledDir } = this.appFilesManager.getAppPaths(appUrn);
    const agentsDir = path.join(appInstalledDir, 'agents');
    const agentsConfig = appInfo.agents as AgentConfig | undefined;

    const skillMdPath = path.join(agentsDir, 'SKILL.md');
    const skillMdExists = await this.filesystem.pathExists(skillMdPath);

    // #936: marketplace MCP listings carry a top-level `mcp` block instead of the
    // Hub-native `agents.mcp`. Normalize it so those 27 apps are visible to the bridge.
    // An explicit `agents.mcp` always wins over the marketplace block.
    const marketplaceMcp = agentsConfig?.mcp ? null : await this.resolveMarketplaceMcp(appUrn, appInfo);

    // S-ACL-1.4: nothing agent-related at all → null
    if (!agentsConfig && !skillMdExists && !marketplaceMcp) {
      return null;
    }

    // S-ACL-1.2: auto-enable skill if SKILL.md exists but no agents field
    if (!agentsConfig) {
      return {
        skill: { enabled: skillMdExists, content: null, inline: false },
        openapi: { enabled: false, specPath: null, config: null },
        mcp: marketplaceMcp ? { enabled: true, config: marketplaceMcp } : { enabled: false, config: null },
      };
    }

    // Resolve skill config (S-ACL-1.1, S-ACL-1.3)
    const skill = this.resolveSkillConfig(agentsConfig, skillMdExists);

    // Resolve openapi config
    const openapi = this.resolveOpenApiConfig(agentsConfig, agentsDir);

    // Resolve mcp config — agents.mcp when declared, marketplace block otherwise
    let mcp = this.resolveMcpConfig(agentsConfig);
    if (!mcp.enabled && marketplaceMcp) {
      mcp = { enabled: true, config: marketplaceMcp };
    }

    return { skill, openapi, mcp };
  }

  /**
   * Normalize a marketplace top-level `mcp` block into the bridge's AgentMcpConfig shape (#936).
   *
   * - stdio: marketplace declares `command: string` + `args: string[]`; the bridge wants
   *   `command: string[]`. The bridge reaches the server with `docker exec -i <container>`,
   *   so resolve the concrete compose container name of the app's main service here
   *   (`<app>_<store>-<service>-1`) rather than leaving the bridge to guess.
   * - http: bridged over the existing HTTP JSON-RPC client (`transport: 'sse'` in bridge
   *   terms) when the listing pins a URL. Hosted/remote listings without a URL (e.g.
   *   miro-mcp) have nothing the Hub can connect to — not bridgeable.
   */
  private async resolveMarketplaceMcp(appUrn: AppUrn, appInfo: AppInfo): Promise<AgentMcpConfig | null> {
    const mcp = appInfo.mcp;
    if (!mcp) return null;

    if (mcp.transport === 'http') {
      if (!mcp.url) return null;
      return { enabled: true, transport: 'sse', url: mcp.url, command: undefined, container: undefined, auth: undefined };
    }

    if (!mcp.command) return null;

    return {
      enabled: true,
      transport: 'stdio',
      command: [mcp.command, ...mcp.args],
      container: await this.resolveMainContainerName(appUrn),
      url: undefined,
      auth: undefined,
    };
  }

  /**
   * Concrete container name of the app's main service as compose names it:
   * `<project>-<service>-1` where the Hub's compose project is `<app>_<store>`.
   * Falls back to the app name as service name if the compose file is unreadable.
   */
  private async resolveMainContainerName(appUrn: AppUrn): Promise<string> {
    const [appName, storeSlug] = appUrn.split(':') as [string, string];
    let serviceName = appName;
    try {
      const composeJson = await this.appFilesManager.getDockerComposeJson(appUrn);
      const parsed = composeJson.content as { services?: Array<{ name?: string; isMain?: boolean }> } | null;
      const main = parsed?.services?.find((s) => s.isMain);
      if (main?.name) serviceName = main.name;
    } catch {
      // fall through to app-name default
    }
    return `${appName}_${storeSlug}-${serviceName}-1`;
  }

  private resolveSkillConfig(agentsConfig: NonNullable<AgentConfig>, _skillMdExists: boolean): ResolvedAgentConfig['skill'] {
    const skillField = agentsConfig.skill;

    if (skillField === undefined || skillField === false) {
      return { enabled: false, content: null, inline: false };
    }

    // S-ACL-1.3: string → inline SKILL.md content
    if (typeof skillField === 'string') {
      return { enabled: true, content: skillField, inline: true };
    }

    // boolean true or object with enabled
    if (skillField === true) {
      return { enabled: true, content: null, inline: false };
    }

    // Object form
    return { enabled: skillField.enabled, content: null, inline: false };
  }

  private resolveOpenApiConfig(agentsConfig: NonNullable<AgentConfig>, agentsDir: string): ResolvedAgentConfig['openapi'] {
    const openapiField = agentsConfig.openapi;

    if (!openapiField?.enabled) {
      return { enabled: false, specPath: null, config: null };
    }

    const specPath = openapiField.spec_path ? path.join(agentsDir, '..', openapiField.spec_path) : path.join(agentsDir, 'openapi.yaml');

    return { enabled: true, specPath, config: openapiField };
  }

  private resolveMcpConfig(agentsConfig: NonNullable<AgentConfig>): ResolvedAgentConfig['mcp'] {
    const mcpField = agentsConfig.mcp;

    if (!mcpField?.enabled) {
      return { enabled: false, config: null };
    }

    return { enabled: true, config: mcpField };
  }

  /**
   * Check if an app has any agent integration layer enabled.
   */
  async hasAgentIntegration(appUrn: AppUrn, appInfo: AppInfo): Promise<boolean> {
    const config = await this.getAgentConfig(appUrn, appInfo);
    if (!config) return false;
    return config.skill.enabled || config.openapi.enabled || config.mcp.enabled;
  }

  /**
   * Get a summary of what agent layers are available for an app.
   */
  async getAgentSummary(appUrn: AppUrn, appInfo: AppInfo): Promise<{ hasSkill: boolean; hasOpenApi: boolean; hasMcp: boolean } | null> {
    const config = await this.getAgentConfig(appUrn, appInfo);
    if (!config) return null;
    return {
      hasSkill: config.skill.enabled,
      hasOpenApi: config.openapi.enabled,
      hasMcp: config.mcp.enabled,
    };
  }
}
