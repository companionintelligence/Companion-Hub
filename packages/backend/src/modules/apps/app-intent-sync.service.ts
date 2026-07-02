import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import type { AgentIntent, AppInfo } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import axios from 'axios';

/**
 * Consumer for app-declared intents (`agents.intents[]`).
 *
 * When an app that declares typed intents is installed, the Hub POSTs those
 * intents to CI-Server's registration API so the assistant's vocabulary grows
 * with the install. On uninstall the Hub tells CI-Server to drop them again.
 *
 * This is the Hub half of the "Hub intent registry sync" plan item
 * (CI-Engineering architecture/subsystems/agents-and-intents.md §4, P1). It
 * follows the install-sink pattern established by the compose sandbox
 * enforcement (CI-Hub #843): side-effects hang off the install/uninstall
 * lifecycle sinks, best-effort, and never block or fail the install itself.
 *
 * The CI-Server endpoints (POST/DELETE `/api/intents/register`) and the
 * `AppIntentToolProvider` that executes them via each intent's `binding` are
 * the CI-Server half of the same item and land separately; until they exist
 * this service degrades to a no-op debug log (sync is skipped when no server
 * URL is configured, and a 404 is swallowed).
 */
@Injectable()
export class AppIntentSyncService {
  constructor(private readonly logger: LoggerService) {}

  /**
   * CI-Server base URL for the intent registry. Server-to-server call inside the
   * appliance core; unset in dev / standalone Hub installs, in which case the
   * sync is skipped entirely.
   */
  private get serverBaseUrl(): string | null {
    const raw = process.env.CI_SERVER_URL?.trim();
    if (!raw) return null;
    return raw.replace(/\/+$/, '');
  }

  /** Optional shared secret (HS256 bearer to CI-Server). Sent when present. */
  private get serverToken(): string | null {
    return process.env.CI_SERVER_INTENT_TOKEN?.trim() || null;
  }

  /**
   * Extract the typed intents an app contributes, namespacing every intent's
   * domain to `app.<slug>.<domain>` so per-app domains never collide with — or
   * require — CI-Server's strict core domain registry (the deferred domain
   * governance decision: per-app namespaced domains, auto-accepted).
   */
  public collectAppIntents(appUrn: AppUrn, info: Pick<AppInfo, 'agents'>): AgentIntent[] {
    const declared = info.agents?.intents;
    if (!declared || declared.length === 0) return [];

    const slug = this.appSlug(appUrn);
    return declared.map((intent) => {
      const namespacedDomain = `app.${slug}.${intent.domain}`;
      return {
        ...intent,
        domain: namespacedDomain,
        // `name` is `<domain>.<action>` — re-derive the action and re-prefix so
        // the published intent id matches its namespaced domain.
        name: `${namespacedDomain}.${this.intentAction(intent.name)}`,
      };
    });
  }

  /**
   * Register an app's declared intents with CI-Server on install. Best-effort:
   * logs and swallows all failures so a server-side hiccup never fails an
   * otherwise-successful install.
   */
  public async registerAppIntents(appUrn: AppUrn, info: Pick<AppInfo, 'agents'>): Promise<void> {
    const intents = this.collectAppIntents(appUrn, info);
    if (intents.length === 0) return;

    const baseUrl = this.serverBaseUrl;
    if (!baseUrl) {
      this.logger.debug(`Skipping intent registration for ${appUrn}: CI_SERVER_URL not configured (${intents.length} intent(s))`);
      return;
    }

    try {
      await axios.post(
        `${baseUrl}/api/intents/register`,
        { appId: appUrn, appSlug: this.appSlug(appUrn), intents },
        { timeout: 5000, headers: this.authHeaders() },
      );
      this.logger.info(`Registered ${intents.length} app intent(s) for ${appUrn} with CI-Server`);
    } catch (error) {
      // A 404 means the CI-Server registration endpoint isn't deployed yet — expected
      // until the server half lands. Log at debug; everything else at warn.
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      const message = error instanceof Error ? error.message : String(error);
      if (status === 404) {
        this.logger.debug(`Intent registration endpoint not available on CI-Server for ${appUrn} (404); skipping`);
      } else {
        this.logger.warn(`Failed to register app intents for ${appUrn}: ${message}`);
      }
    }
  }

  /**
   * Drop an app's intents from CI-Server on uninstall. Best-effort, same
   * failure handling as registration.
   */
  public async unregisterAppIntents(appUrn: AppUrn): Promise<void> {
    const baseUrl = this.serverBaseUrl;
    if (!baseUrl) {
      this.logger.debug(`Skipping intent unregistration for ${appUrn}: CI_SERVER_URL not configured`);
      return;
    }

    try {
      await axios.delete(`${baseUrl}/api/intents/register/${encodeURIComponent(appUrn)}`, {
        timeout: 5000,
        headers: this.authHeaders(),
      });
      this.logger.info(`Unregistered app intents for ${appUrn} with CI-Server`);
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      const message = error instanceof Error ? error.message : String(error);
      if (status === 404) {
        this.logger.debug(`Intent unregistration for ${appUrn}: nothing registered or endpoint unavailable (404); skipping`);
      } else {
        this.logger.warn(`Failed to unregister app intents for ${appUrn}: ${message}`);
      }
    }
  }

  private authHeaders(): Record<string, string> {
    const token = this.serverToken;
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  /** `<appName>:<appStoreSlug>` → `<appName>` (the human-facing app slug). */
  private appSlug(appUrn: AppUrn): string {
    return appUrn.split(':')[0] ?? appUrn;
  }

  /** Last dotted segment of a `<domain>.<action>` intent name. */
  private intentAction(name: string): string {
    const parts = name.split('.');
    return parts[parts.length - 1] ?? name;
  }
}
