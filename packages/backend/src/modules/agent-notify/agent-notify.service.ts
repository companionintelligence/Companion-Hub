import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';

type Urgency = 'high' | 'medium' | 'low' | 'info';

@Injectable()
export class AgentNotifyService implements OnModuleDestroy {
  private debounceMap = new Map<string, number>();
  private debounceWindowMs = 30_000;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly logger: LoggerService) {
    this.cleanupInterval = setInterval(() => this.cleanupDebounceMap(), 60_000);
  }

  onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  async notify(event: string, data: Record<string, unknown>, urgency: Urgency): Promise<void> {
    const webhookUrl = process.env.AGENT_WEBHOOK_URL;
    const enabled = process.env.AGENT_WEBHOOK_ENABLED !== 'false';

    if (!webhookUrl || !enabled) {
      return;
    }

    const debounceKey = this.buildDebounceKey(event, data);
    if (this.isDuplicateWithinWindow(debounceKey)) {
      return;
    }
    this.debounceMap.set(debounceKey, Date.now());

    const token = process.env.AGENT_WEBHOOK_TOKEN;
    const payload = {
      event,
      data,
      urgency,
      timestamp: new Date().toISOString(),
    };

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        this.logger.error(`Agent webhook returned ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      this.logger.error('Agent webhook POST failed:', error);
    }
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
