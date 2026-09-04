import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { parseComposeJson } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { createAppUrn, extractAppUrn } from '@/common/helpers/app-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { EnvUtils } from '@/modules/env/env.utils';
import { buildWakeText, DEFAULT_MIN_URGENCY, isUrgency, passesUrgency, type Urgency } from './wake-text';

export type { Urgency };

/** Avoids dependency on plugin routing by using OpenClaw's native wake hook. */
const DEFAULT_WAKE_ENDPOINT = '/hooks/wake';

/**
 * Treat this persisted endpoint as an obsolete default. The plugin route never registered
 * successfully, and rewriting it lets installed apps use the native hook without an app
 * update (CI-Hub#897).
 */
const LEGACY_PLUGIN_WAKE_ENDPOINT = '/hooks/hub-wake';

export interface WebhookTarget {
  url: string;
  token?: string;
  appUrn: string;
}

/**
 * Send the same secret in both supported headers. OpenClaw prioritizes `Authorization`, so
 * mismatched values would reject an otherwise valid request through either route.
 */
const WAKE_TOKEN_HEADER = 'X-OpenClaw-Token';

@Injectable()
export class AgentNotifyService implements OnApplicationBootstrap, OnModuleDestroy {
  private debounceMap = new Map<string, number>();
  private debounceWindowMs = 30_000;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private webhooks = new Map<string, WebhookTarget>();

  constructor(
    private readonly logger: LoggerService,
    private readonly moduleRef: ModuleRef,
  ) {
    this.cleanupInterval = setInterval(() => this.cleanupDebounceMap(), 60_000);
  }

  /**
   * Rebuilds the in-memory webhook registry after a restart. Per-app failures remain
   * isolated so one unreadable app cannot block Hub startup or other registrations.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const appsRepository = this.moduleRef.get(AppsRepository, { strict: false });
      const apps = await appsRepository.getApps();

      // Resolve apps concurrently because startup requires three independent reads per app.
      // Keep failures isolated so one app cannot block other registrations.
      const resolved = await Promise.all(
        apps.map(async (app) => {
          const appUrn = createAppUrn(app.appName, app.appStoreSlug);
          try {
            return { appUrn, target: await this.resolveWebhookTarget(appUrn) };
          } catch (error) {
            this.logger.warn(`Could not restore the agent webhook for ${appUrn}: ${error}`);
            return { appUrn, target: null };
          }
        }),
      );

      let registered = 0;
      for (const { appUrn, target } of resolved) {
        if (!target) continue;
        this.registerWebhook(appUrn, target.url, target.token);
        registered += 1;
      }

      this.logger.info(`Restored ${registered} agent webhook(s) from ${apps.length} installed app(s)`);
    } catch (error) {
      this.logger.error('Failed to restore agent webhooks on startup:', error);
    }
  }

  /**
   * Reconstructs an app's wake URL and secret from installed files. Returns null when the
   * app declares no wake capability. Docker DNS requires the Compose service name rather
   * than the app URN name.
   */
  async resolveWebhookTarget(appUrn: string): Promise<{ url: string; token?: string } | null> {
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });

    const appInfo = await appFilesManager.getInstalledAppInfo(appUrn as AppUrn);
    const hubIntegration = appInfo?.hub_integration;
    if (!hubIntegration?.mcp_client) {
      return null;
    }

    // `mcp_client` declares tool consumption, not wake support. The schema supplies the dead
    // legacy endpoint when none is declared, so only a port or a different endpoint proves
    // wake support; otherwise Hub events would be sent to a 404 (CI-Hub#897).
    const declaresEndpoint = Boolean(hubIntegration.wake_endpoint) && hubIntegration.wake_endpoint !== LEGACY_PLUGIN_WAKE_ENDPOINT;
    if (!declaresEndpoint && !hubIntegration.wake_port) {
      this.logger.debug(`No wake endpoint declared for ${appUrn}; it uses Hub tools but cannot be woken`);
      return null;
    }

    const configured = hubIntegration.wake_endpoint;
    const wakeEndpoint = !configured || configured === LEGACY_PLUGIN_WAKE_ENDPOINT ? DEFAULT_WAKE_ENDPOINT : configured;
    const wakePort = hubIntegration.wake_port || appInfo?.port || 3000;

    // Use the shared URN parser so the store slug cannot be mistaken for the app name.
    let serviceName: string = extractAppUrn(appUrn as AppUrn).appName;
    try {
      const composeJson = await appFilesManager.getDockerComposeJson(appUrn as AppUrn);
      if (composeJson.content) {
        const parsed = parseComposeJson(composeJson.content);
        const mainService = parsed.services.find((s) => s.isMain) || parsed.services[0];
        if (mainService?.name) {
          serviceName = mainService.name;
        }
      }
    } catch {
      this.logger.debug(`Could not parse compose for ${appUrn}; falling back to "${serviceName}"`);
    }

    const envUtils = this.moduleRef.get(EnvUtils, { strict: false });
    const agentEnv = await appFilesManager.getAppEnv(appUrn as AppUrn);
    const token = envUtils.envStringToMap(agentEnv.content).get('HUB_WAKE_SECRET');

    return { url: `http://${serviceName}:${wakePort}${wakeEndpoint}`, token };
  }

  onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  registerWebhook(appUrn: string, url: string, token?: string): void {
    this.webhooks.set(appUrn, { url, token, appUrn });
    this.logger.info(`Registered agent webhook for ${appUrn}: ${url}`);
  }

  unregisterWebhook(appUrn: string): boolean {
    const removed = this.webhooks.delete(appUrn);
    if (removed) {
      this.logger.info(`Unregistered agent webhook for ${appUrn}`);
    }
    return removed;
  }

  getRegisteredWebhooks(): WebhookTarget[] {
    return [...this.webhooks.values()];
  }

  private getAllTargets(): Array<{ url: string; token?: string }> {
    // Deduplicate because the compatibility environment target can name an auto-registered
    // app. Registered entries overwrite it because each app's on-disk secret is authoritative.
    const byUrl = new Map<string, { url: string; token?: string }>();

    const envUrl = process.env.AGENT_WEBHOOK_URL;
    if (envUrl) {
      byUrl.set(envUrl, { url: envUrl, token: process.env.AGENT_WEBHOOK_TOKEN });
    }

    for (const wh of this.webhooks.values()) {
      byUrl.set(wh.url, { url: wh.url, token: wh.token });
    }

    return [...byUrl.values()];
  }

  /**
   * Wakes one app without fan-out, urgency filtering, or debounce. Memory dispatches use
   * this targeted path so unrelated agents do not run.
   */
  async wakeApp(appUrn: string, data: { jobId: string }): Promise<boolean> {
    let target = this.webhooks.get(appUrn);
    if (!target) {
      try {
        const resolved = await this.resolveWebhookTarget(appUrn);
        if (resolved) {
          this.registerWebhook(appUrn, resolved.url, resolved.token);
          target = this.webhooks.get(appUrn);
        }
      } catch (error) {
        this.logger.warn(`Could not resolve wake target for ${appUrn}: ${error}`);
      }
    }

    if (!target) {
      this.logger.warn(`No wake target registered for ${appUrn}`);
      return false;
    }

    const text = `Memory dispatch job ${data.jobId}. Fetch the packet from Memory.`;
    return this.postWake(target, text);
  }

  /**
   * Wakes agents for a Hub event after applying the urgency floor and debounce. The Hub
   * converts its event vocabulary to text for OpenClaw's native hook, which can coalesce
   * bursts during its heartbeat window (CI-Hub#897).
   */
  async notify(event: string, data: Record<string, unknown>, urgency: Urgency): Promise<void> {
    const enabled = process.env.AGENT_WEBHOOK_ENABLED !== 'false';
    if (!enabled) {
      return;
    }

    const minUrgency = this.resolveMinUrgency();
    if (!passesUrgency(urgency, minUrgency)) {
      this.logger.debug(`Agent wake skipped: ${event} (${urgency}) is below the ${minUrgency} floor`);
      return;
    }

    const targets = this.getAllTargets();
    if (targets.length === 0) {
      return;
    }

    const debounceKey = this.buildDebounceKey(event, data);
    if (this.isDuplicateWithinWindow(debounceKey)) {
      return;
    }
    this.debounceMap.set(debounceKey, Date.now());

    // `now` avoids waiting up to 30 minutes for the next scheduled heartbeat.
    await Promise.allSettled(targets.map((target) => this.postWake(target, buildWakeText(event, data, urgency))));
  }

  private async postWake(target: { url: string; token?: string }, text: string): Promise<boolean> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (target.token) {
      headers[WAKE_TOKEN_HEADER] = target.token;
      headers.Authorization = `Bearer ${target.token}`;
    }

    try {
      const response = await fetch(target.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text, mode: 'now' }),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After') ?? 'unspecified';
        this.logger.warn(`Agent wake throttled by ${target.url} (retry-after: ${retryAfter}s)`);
        return false;
      }

      if (!response.ok) {
        this.logger.error(`Agent wake ${target.url} returned ${response.status}: ${response.statusText}`);
        return false;
      }

      this.logger.debug(`Agent woken via ${target.url}`);
      return true;
    } catch (error) {
      this.logger.error(`Agent wake POST to ${target.url} failed:`, error);
      return false;
    }
  }

  /**
   * Reads the minimum urgency per call so configuration changes apply without a restart.
   * Invalid values fall back to the default to avoid suppressing all wakes.
   */
  private resolveMinUrgency(): Urgency {
    const configured = process.env.AGENT_WEBHOOK_MIN_URGENCY;
    if (!configured) {
      return DEFAULT_MIN_URGENCY;
    }
    if (isUrgency(configured)) {
      return configured;
    }
    this.logger.warn(`Ignoring unrecognized AGENT_WEBHOOK_MIN_URGENCY="${configured}"; using "${DEFAULT_MIN_URGENCY}"`);
    return DEFAULT_MIN_URGENCY;
  }

  private buildDebounceKey(event: string, data: Record<string, unknown>): string {
    const appUrn = data.appUrn ?? '';
    return `${event}:${appUrn}`;
  }

  private isDuplicateWithinWindow(key: string): boolean {
    const lastSent = this.debounceMap.get(key);
    if (!lastSent) return false;
    return Date.now() - lastSent < this.debounceWindowMs;
  }

  private cleanupDebounceMap(): void {
    const now = Date.now();
    for (const [key, timestamp] of this.debounceMap) {
      if (now - timestamp > this.debounceWindowMs * 2) {
        this.debounceMap.delete(key);
      }
    }
  }

  _getDebounceMap(): Map<string, number> {
    return this.debounceMap;
  }

  _setDebounceWindowMs(ms: number): void {
    this.debounceWindowMs = ms;
  }
}
