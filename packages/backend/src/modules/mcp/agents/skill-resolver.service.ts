import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import type { AppUrn } from '@ci-hub/common/types';
import type { ResolvedAgentConfig } from './agent-config.service';

/**
 * Loads SKILL.md files and resolves template variables.
 * Implements ACL-2 (template variable resolution) and ASK-1 (skill retrieval).
 */
@Injectable()
export class SkillResolverService {
  constructor(
    private readonly appFilesManager: AppFilesManager,
    private readonly filesystem: FilesystemService,
    private readonly config: ConfigurationService,
    readonly _logger: LoggerService,
  ) {}

  /**
   * Load and resolve the SKILL.md content for an app.
   * S-ASK-1.1: returns { content, available }
   * S-ASK-1.2: returns available=false when no SKILL.md
   * S-ASK-1.3: all template variables resolved
   */
  async getSkillContent(
    appUrn: AppUrn,
    agentConfig: ResolvedAgentConfig | null,
    appEnvVars?: Record<string, string>,
  ): Promise<{ content: string; available: boolean }> {
    if (!agentConfig?.skill.enabled) {
      return { content: '', available: false };
    }

    // Inline content (S-ACL-1.3)
    if (agentConfig.skill.inline && agentConfig.skill.content) {
      const resolved = this.resolveTemplateVariables(agentConfig.skill.content, appUrn, appEnvVars);
      return { content: resolved, available: true };
    }

    // Load from file
    const { appInstalledDir } = this.appFilesManager.getAppPaths(appUrn);
    const skillPath = path.join(appInstalledDir, 'agents', 'SKILL.md');

    const rawContent = await this.filesystem.readTextFile(skillPath);
    if (!rawContent) {
      return { content: '', available: false };
    }

    const resolved = this.resolveTemplateVariables(rawContent, appUrn, appEnvVars);
    return { content: resolved, available: true };
  }

  /**
   * Resolve template variables in content.
   * S-ACL-2.1: ${APP_HOST} → app internal hostname
   * S-ACL-2.2: ${APP_PORT} → app configured port
   * S-ACL-2.3: ${APP_DOMAIN} → app public domain (or empty string)
   * S-ACL-2.4: ${ENV:<key>} → app env variable value
   * S-ACL-2.5: Unresolved variables are left as-is
   */
  resolveTemplateVariables(content: string, appUrn: AppUrn, appEnvVars?: Record<string, string>): string {
    const vars = this.buildVariableMap(appUrn, appEnvVars);

    // Replace ${VAR_NAME} patterns
    return content.replace(/\$\{([^}]+)\}/g, (match, varName: string) => {
      // Handle ${ENV:<key>} pattern
      if (varName.startsWith('ENV:')) {
        const envKey = varName.slice(4);
        return appEnvVars?.[envKey] ?? match; // S-ACL-2.5: leave as-is if unresolved
      }

      // Standard variables
      if (varName in vars) {
        return vars[varName] ?? '';
      }

      // S-ACL-2.5: leave unresolved variables as-is
      return match;
    });
  }

  private buildVariableMap(appUrn: AppUrn, appEnvVars?: Record<string, string>): Record<string, string> {
    const [storeSlug, appName] = appUrn.split(':') as [string, string];
    const userSettings = this.config.getConfig().userSettings;

    return {
      APP_HOST: appEnvVars?.APP_HOST ?? `${appName}-${storeSlug}`,
      APP_PORT: appEnvVars?.APP_PORT ?? '',
      APP_DOMAIN: appEnvVars?.APP_DOMAIN ?? '',
      APP_LOCAL_DOMAIN: appEnvVars?.LOCAL_DOMAIN ?? userSettings?.localDomain ?? '',
      APP_URN: appUrn,
      APP_DATA_DIR: appEnvVars?.APP_DATA_DIR ?? '',
    };
  }
}
