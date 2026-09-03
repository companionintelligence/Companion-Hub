import type { OpenClawPluginApi, WakePayload } from './types';
import { passesFilter, translateWakeMessage, type WakeFilterConfig } from './wake-endpoint';

/**
 * SSE listener service that subscribes to the Hub's SSE stream
 * and generates wake events from real-time status changes.
 */
export class SseListenerService {
  private hubUrl: string;
  private apiKey: string;
  private api: OpenClawPluginApi;
  private wakeFilter?: WakeFilterConfig;
  private abortController: AbortController | null = null;
  private running = false;
  private backoffMs = 1000;
  private readonly maxBackoffMs = 60_000;

  constructor(hubUrl: string, apiKey: string, api: OpenClawPluginApi, wakeFilter?: WakeFilterConfig) {
    this.hubUrl = hubUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.api = api;
    this.wakeFilter = wakeFilter;
  }

  async start(): Promise<void> {
    this.running = true;
    this.api.log.info('SSE listener starting...');
    await this.connectSse();
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
    this.api.log.info('SSE listener stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  private async connectSse(): Promise<void> {
    if (!this.running) return;

    try {
      this.abortController = new AbortController();
      const response = await fetch(`${this.hubUrl}/sse/app`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: this.abortController.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`SSE connection failed: ${response.status}`);
      }

      this.backoffMs = 1000;
      this.api.log.info('SSE listener connected');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              this.handleSseEvent(data);
            } catch {
              // Skip malformed SSE data
            }
          }
        }
      }
    } catch (error) {
      if (this.running) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes('abort')) {
          this.api.log.warn(`SSE connection lost: ${msg}`);
          this.scheduleReconnect();
        }
      }
    }
  }

  private handleSseEvent(data: Record<string, unknown>): void {
    const sseEvent = data.event as string;
    if (!sseEvent) return;

    let wakePayload: WakePayload | null = null;

    // Detect crash: status_change from running to stopped/missing
    if (sseEvent === 'status_change') {
      const appStatus = data.appStatus as string;
      if (appStatus === 'stopped' || appStatus === 'missing') {
        wakePayload = {
          event: 'app.crashed',
          data: { appUrn: data.appUrn, newStatus: appStatus },
          urgency: 'high',
          timestamp: new Date().toISOString(),
        };
      }
    }

    // Error events → high urgency wake
    const errorEvents = ['install_error', 'update_error', 'start_error', 'stop_error', 'restart_error', 'backup_error', 'restore_error'];
    if (errorEvents.includes(sseEvent)) {
      wakePayload = {
        event: sseEvent,
        data: { appUrn: data.appUrn, error: data.error },
        urgency: 'high',
        timestamp: new Date().toISOString(),
      };
    }

    // Success events → info urgency wake
    const successEvents = [
      'install_success',
      'update_success',
      'start_success',
      'stop_success',
      'restart_success',
      'backup_success',
      'restore_success',
    ];
    if (successEvents.includes(sseEvent)) {
      wakePayload = {
        event: sseEvent,
        data: { appUrn: data.appUrn },
        urgency: 'info',
        timestamp: new Date().toISOString(),
      };
    }

    if (wakePayload && passesFilter(wakePayload, this.wakeFilter)) {
      const message = translateWakeMessage(wakePayload);
      this.api.wake(message);
      this.api.log.info(`SSE wake: ${wakePayload.event} (${wakePayload.urgency})`);
    }
  }

  private scheduleReconnect(): void {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.api.log.info(`SSE reconnecting in ${delay}ms...`);
    setTimeout(() => this.connectSse(), delay);
  }
}
