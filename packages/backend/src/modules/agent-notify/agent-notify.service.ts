import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';

type Urgency = 'high' | 'medium' | 'low' | 'info';

export interface WebhookTarget {
  url: string;
  token?: string;
  appUrn: string;
}

@Injectable()
export class AgentNotifyService implements OnModuleDestroy {
  private debounceMap = new Map<string, number>();
  private debounceWindowMs = 30_000;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private webhooks = new Map<string, WebhookTarget>();

  constructor(private readonly logger: LoggerService) {
    this.cleanupInterval = setInterval(() => this.cleanupDebounceMap(), 60_000);
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

  async notify(event: string, data: Record<string, unknown>, urgency: Urgency): Promise<void> {
    const enabled = process.env.AGENT_WEBHOOK_ENABLED !== 'false';
    if (!enabled) {
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

    const payload = {
      event,
      data,
      urgency,
      timestamp: new Date().toISOString(),
    };
    const body = JSON.stringify(payload);

    await Promise.allSettled(
      targets.map(async (target) => {
        try {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (target.token) {
            headers.Authorization = `Bearer ${target.token}`;
          }

          const response = await fetch(target.url, {
            method: 'POST',
            headers,
            body,
            signal: AbortSignal.timeout(10_000),
          });

          if (!response.ok) {
            this.logger.error(`Agent webhook ${target.url} returned ${response.status}: ${response.statusText}`);
          }
        } catch (error) {
          this.logger.error(`Agent webhook POST to ${target.url} failed:`, error);
        }
      }),
    );
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
