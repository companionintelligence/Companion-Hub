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

/**
 * OpenClaw's own wake hook. The agent listens here natively — there is no plugin involved.
 */
const DEFAULT_WAKE_ENDPOINT = '/hooks/wake';

/**
 * The path the ci-hub OpenClaw plugin tried, and failed, to serve.
 *
 * It never worked: the plugin registered the route without the `auth` field OpenClaw
 * requires, so the route was rejected and every wake 404'd for the life of the feature
 * (CI-Hub#897). It is nonetheless frozen into the on-disk `config.json` of every app
 * already installed, because that file is a snapshot of the marketplace manifest taken at
 * install time.
 *
 * So we rewrite it rather than honour it. Honouring it would mean an installed app kept
 * POSTing into a 404 until someone bumped the manifest AND ran an app update — and it would
 * make the rollout order load-bearing, where shipping the manifest before the image would
 * break every wake. Treating the legacy path as "the default" makes wake start working on
 * the next Hub restart, for apps that are already installed, with no manifest change at all.
 *
 * There is nothing to preserve: no deployment has ever served this path successfully.
 */
const LEGACY_PLUGIN_WAKE_ENDPOINT = '/hooks/hub-wake';

export interface WebhookTarget {
  url: string;
  token?: string;
  appUrn: string;
}

/**
 * The wake secret is sent in BOTH `Authorization: Bearer` and this header. They carry the same
 * value, so whichever OpenClaw reads, it matches.
 *
 * That redundancy is deliberate, and the reasoning is not obvious. OpenClaw's hook auth
 * (`extractHookToken`) reads `Authorization: Bearer` FIRST and returns as soon as it finds a
 * non-empty token — it never falls back to `X-OpenClaw-Token`. So `Authorization` is not a
 * harmless extra: whatever ends up in it DECIDES the request.
 *
 * The Hub POSTs to the app's published port, which for CI-OpenClaw is its setup server, and
 * that proxy used to overwrite `Authorization` with the OpenClaw *gateway* token before
 * forwarding. The hook then compared the gateway token against `hooks.token`, and every wake
 * 401'd — including ones sent in `X-OpenClaw-Token`, because the injected Bearer shadowed it.
 * Measured on core-2: through the proxy → 401; the identical request straight to the gateway →
 * 200 `{"ok":true,"mode":"now"}`. CI-OpenClaw now leaves `Authorization` alone on `/hooks/*`
 * (proxy-headers.cjs), which is what makes either header work.
 *
 * Sending both means a wake survives whichever way it is routed: through the setup-server
 * proxy, or straight to a gateway.
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
   * Rebuild the webhook registry from the apps already installed on disk.
   *
   * The registry is in-memory, and until now `registerWebhook()` was only ever called from
   * the install path. So every Hub restart silently emptied it: an app installed yesterday
   * received no wakes today, and nothing said why. Rehydrating here makes the registry a
   * function of what is installed rather than of what happened to be installed *during this
   * process's lifetime*.
   *
   * Never throws. A single unreadable app must not stop the others from registering, and it
   * certainly must not take down Hub startup.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const appsRepository = this.moduleRef.get(AppsRepository, { strict: false });
      const apps = await appsRepository.getApps();

      // Resolved concurrently: each app costs three independent disk reads, and this sits on
      // the Hub's startup path. Errors stay isolated per app — one unreadable app must not cost
      // the others their webhook.
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
        if (!target) continue; // cannot be woken; nothing to register
        this.registerWebhook(appUrn, target.url, target.token);
        registered += 1;
      }

      this.logger.info(`Restored ${registered} agent webhook(s) from ${apps.length} installed app(s)`);
    } catch (error) {
      this.logger.error('Failed to restore agent webhooks on startup:', error);
    }
  }

  /**
   * Where an app's agent listens, and the secret to talk to it — derived from what is on
   * disk, so it is reproducible after a restart rather than captured once at install time.
   *
   * Returns null for an app that does not run an agent (`hub_integration.mcp_client` unset).
   *
   * The host is the compose *service* name, not `{appName}-{storeId}`: on the shared
   * ci-os-hub network that is the name Docker DNS actually resolves.
   */
  async resolveWebhookTarget(appUrn: string): Promise<{ url: string; token?: string } | null> {
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });

    const appInfo = await appFilesManager.getInstalledAppInfo(appUrn as AppUrn);
    const hubIntegration = appInfo?.hub_integration;
    if (!hubIntegration?.mcp_client) {
      return null;
    }

    // `mcp_client` says the app CONSUMES Hub MCP tools. It does not say the app can be woken,
    // and the two are not the same set: CI-Hermes sets `mcp_client: true` and serves no hook at
    // all. An app declares wake capability by naming an endpoint or a port — with neither, there
    // is nothing to POST to, and registering it anyway would fan every Hub event out into a 404
    // (once at install before, and now on every boot, since the registry is rehydrated).
    if (!hubIntegration.wake_endpoint && !hubIntegration.wake_port) {
      this.logger.debug(`No wake endpoint declared for ${appUrn}; it uses Hub tools but cannot be woken`);
      return null;
    }

    const configured = hubIntegration.wake_endpoint;
    const wakeEndpoint = !configured || configured === LEGACY_PLUGIN_WAKE_ENDPOINT ? DEFAULT_WAKE_ENDPOINT : configured;
    const wakePort = hubIntegration.wake_port || appInfo?.port || 3000;

    // An AppUrn is `${appName}:${appStoreSlug}` — parse it with the shared helper rather than
    // re-deriving it, which is how wake-text came to read the store slug as the app name.
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
    const targets: Array<{ url: string; token?: string }> = [];

    // Backward compat: env-based webhook
    const envUrl = process.env.AGENT_WEBHOOK_URL;
    if (envUrl) {
      targets.push({ url: envUrl, token: process.env.AGENT_WEBHOOK_TOKEN });
    }

    // Registered webhooks
    for (const wh of this.webhooks.values()) {
      targets.push({ url: wh.url, token: wh.token });
    }

    return targets;
  }

  /**
   * Wake the agent for a Hub event.
   *
   * The target is OpenClaw's NATIVE wake hook (`POST /hooks/wake`), which takes
   * `{ text, mode }` and answers it by queueing a system event and running an immediate
   * heartbeat turn. We therefore translate the event to text here, in the Hub, which is
   * where the event vocabulary lives. (This replaces a hand-rolled wake route in the
   * ci-hub OpenClaw plugin that 404'd for its entire life — CI-Hub#897.)
   *
   * Three filters stand between an event and an agent turn, and they compose:
   *   - urgency floor (here) — is this worth a turn at all?
   *   - the 30s debounce (here) — the same event for the same app, again
   *   - OpenClaw's own 250ms heartbeat coalescing — a burst becomes ONE turn that sees
   *     every queued event, which is also the better outcome for the user.
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

    // `mode: "now"` is what makes OpenClaw run the turn immediately. The alternative,
    // "next-heartbeat", defers it to the next scheduled slot — up to 30 minutes away.
    const body = JSON.stringify({ text: buildWakeText(event, data, urgency), mode: 'now' });

    await Promise.allSettled(
      targets.map(async (target) => {
        try {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (target.token) {
            headers[WAKE_TOKEN_HEADER] = target.token;
            headers.Authorization = `Bearer ${target.token}`;
          }

          const response = await fetch(target.url, {
            method: 'POST',
            headers,
            body,
            signal: AbortSignal.timeout(10_000),
          });

          if (response.status === 429) {
            // OpenClaw is shedding load, not failing. The system events we already queued
            // are still delivered by the next heartbeat, so nothing is lost — only delayed.
            const retryAfter = response.headers.get('Retry-After') ?? 'unspecified';
            this.logger.warn(`Agent wake throttled by ${target.url} (retry-after: ${retryAfter}s)`);
            return;
          }

          if (!response.ok) {
            this.logger.error(`Agent wake ${target.url} returned ${response.status}: ${response.statusText}`);
            return;
          }

          this.logger.debug(`Agent woken for ${event} (${urgency}) via ${target.url}`);
        } catch (error) {
          this.logger.error(`Agent wake POST to ${target.url} failed:`, error);
        }
      }),
    );
  }

  /**
   * How urgent an event must be to be worth an agent turn.
   *
   * Read per call rather than cached, so it can be changed without a Hub restart — and,
   * more to the point, so it is *actually settable*. Alongside AGENT_WEBHOOK_ENABLED /
   * _URL / _TOKEN, which is where this module's other knobs already live.
   *
   * An unrecognized value falls back to the default rather than silently disabling every
   * wake, which is what a typo would otherwise do.
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

  /** Exposed for testing */
  _getDebounceMap(): Map<string, number> {
    return this.debounceMap;
  }

  _setDebounceWindowMs(ms: number): void {
    this.debounceWindowMs = ms;
  }
}
