import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import type { AppUrn } from '@ci-hub/common/types';
import type { AgentConfig, AppInfo } from '@ci-hub/common/schemas';

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

    // S-ACL-1.4: no agents field and no agents/ directory → null
    if (!agentsConfig && !skillMdExists) {
      const agentsDirExists = await this.filesystem.pathExists(agentsDir);
      if (!agentsDirExists) {
        return null;
      }
      // Check if there's anything in agents/ at all
      if (!skillMdExists) {
        return null;
      }
    }

    // S-ACL-1.2: auto-enable skill if SKILL.md exists but no agents field
    if (!agentsConfig && skillMdExists) {
      return {
        skill: { enabled: true, content: null, inline: false },
        openapi: { enabled: false, specPath: null, config: null },
        mcp: { enabled: false, config: null },
      };
    }

    if (!agentsConfig) {
      return null;
    }

    // Resolve skill config (S-ACL-1.1, S-ACL-1.3)
    const skill = this.resolveSkillConfig(agentsConfig, skillMdExists);

    // Resolve openapi config
    const openapi = this.resolveOpenApiConfig(agentsConfig, agentsDir);

    // Resolve mcp config
    const mcp = this.resolveMcpConfig(agentsConfig);

    return { skill, openapi, mcp };
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
