import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '@/modules/docker/docker.service';
import { AppsService } from '@/modules/apps/apps.service';
import { buildMcpInstallSchema } from '@ci-hub/common/validation';
import type { AppUrn } from '@ci-hub/common/types';
import { AgentConfigService } from './agents/agent-config.service';
import { McpBridgeService } from './agents/mcp-bridge.service';

export type McpContainerStatus = 'running' | 'stopped' | 'missing' | 'unknown';

export type McpProbeResult = {
  bridgeable: boolean;
  transport?: string;
  containerStatus: McpContainerStatus;
  toolCount: number;
  lastError?: string;
  lastProbeAt?: string;
  bridgeWarning?: string;
  connected: boolean;
};

/**
 * Post-install MCP bridge diagnostics — initialize + tools/list against installed app containers.
 * Reuses McpBridgeService handshake logic (same path as hub_list_app_tools).
 */
@Injectable()
export class McpProbeService {
  private readonly cache = new Map<AppUrn, McpProbeResult>();

  constructor(
    private readonly logger: LoggerService,
    private readonly appsService: AppsService,
    private readonly dockerService: DockerService,
    private readonly agentConfigService: AgentConfigService,
    private readonly mcpBridgeService: McpBridgeService,
  ) {}

  getCached(appUrn: AppUrn): McpProbeResult | null {
    return this.cache.get(appUrn) ?? null;
  }

  /** Run MCP handshake probe for an installed app and cache the result. */
  async probe(appUrn: AppUrn): Promise<McpProbeResult> {
    const base = await this.buildBaseStatus(appUrn);

    if (!base.bridgeable) {
      this.cache.set(appUrn, base);
      return base;
    }

    if (base.containerStatus !== 'running') {
      base.lastError = base.lastError ?? `Container is ${base.containerStatus}`;
      this.cache.set(appUrn, base);
      return base;
    }

    try {
      const { info } = await this.appsService.getApp(appUrn);
      const agentConfig = await this.agentConfigService.getAgentConfig(appUrn, info);
      if (!agentConfig?.mcp.enabled || !agentConfig.mcp.config) {
        base.lastError = 'No MCP configuration resolved for this app';
        this.cache.set(appUrn, base);
        return base;
      }

      const tools = await this.mcpBridgeService.discoverTools(appUrn, agentConfig);
      base.connected = true;
      base.toolCount = tools.length;
      base.lastError = undefined;
      base.lastProbeAt = new Date().toISOString();
      this.logger.info(`MCP probe OK for ${appUrn}: ${tools.length} tools`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      base.connected = false;
      base.toolCount = 0;
      base.lastError = message.slice(0, 500);
      base.lastProbeAt = new Date().toISOString();
      this.logger.warn(`MCP probe failed for ${appUrn}: ${message}`);
    }

    this.cache.set(appUrn, base);
    return base;
  }

  /** Fire-and-forget probe after install/start — gives containers time to boot. */
  scheduleProbe(appUrn: AppUrn, delayMs = 8000): void {
    setTimeout(() => {
      void this.probe(appUrn).catch((err) => {
        this.logger.warn(`Scheduled MCP probe failed for ${appUrn}: ${err}`);
      });
    }, delayMs);
  }

  private async buildBaseStatus(appUrn: AppUrn): Promise<McpProbeResult> {
    const { app, info } = await this.appsService.getApp(appUrn);
    const installSchema = buildMcpInstallSchema(info);
    const transport = info.mcp?.transport;

    if (!installSchema) {
      return {
        bridgeable: false,
        transport,
        containerStatus: 'unknown',
        toolCount: 0,
        lastError: 'Not an MCP app',
        connected: false,
        lastProbeAt: new Date().toISOString(),
      };
    }

    const containerStatus = await this.resolveContainerStatus(appUrn, app?.status);
    const bridgeable = installSchema.bridgeable;
    let lastError: string | undefined = installSchema.bridgeWarning;

    if (!app || app.status === 'missing') {
      lastError = 'App is not installed';
    } else if (app.status !== 'running') {
      lastError = `App status is ${app.status}`;
    }

    return {
      bridgeable,
      transport: installSchema.transport,
      containerStatus,
      toolCount: installSchema.toolCount,
      bridgeWarning: installSchema.bridgeWarning,
      lastError,
      connected: false,
      lastProbeAt: new Date().toISOString(),
    };
  }

  private async resolveContainerStatus(appUrn: AppUrn, appStatus?: string): Promise<McpContainerStatus> {
    if (appStatus === 'missing' || !appStatus) return 'missing';
    try {
      const diag = await this.dockerService.diagnoseAppContainers(appUrn);
      if (diag.healthy.length > 0 && diag.unhealthy.length === 0) return 'running';
      if (diag.unhealthy.length > 0) return 'stopped';
      if (diag.healthy.length === 0 && diag.unhealthy.length === 0) return appStatus === 'running' ? 'unknown' : 'stopped';
      return 'unknown';
    } catch {
      return appStatus === 'running' ? 'unknown' : 'stopped';
    }
  }
}
