import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { SystemService } from '@/modules/system/system.service';
import { AgentNotifyService } from './agent-notify.service';

@Injectable()
export class AgentHealthCheckService implements OnApplicationBootstrap, OnModuleDestroy {
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private healthDebounceMap = new Map<string, number>();
  private healthDebounceMs = 60 * 60 * 1000; // 1 hour

  constructor(
    private readonly systemService: SystemService,
    private readonly agentNotifyService: AgentNotifyService,
  ) {}

  onApplicationBootstrap() {
    const intervalMinutes = Number(process.env.AGENT_HEALTH_CHECK_INTERVAL_MINUTES) || 15;
    this.checkInterval = setInterval(() => this.runHealthCheck(), intervalMinutes * 60 * 1000);
  }

  onModuleDestroy() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
  }

  async runHealthCheck(): Promise<void> {
    try {
      const load = await this.systemService.getSystemLoad();

      if (load.percentUsed > 90 && !this.isHealthEventDebounced('system.high_disk')) {
        this.healthDebounceMap.set('system.high_disk', Date.now());
        await this.agentNotifyService.notify(
          'system.high_disk',
          { usagePercent: load.percentUsed, availableGb: load.diskSize - load.diskUsed },
          'high',
        );
      }

      if (load.percentUsedMemory > 90 && !this.isHealthEventDebounced('system.high_memory')) {
        this.healthDebounceMap.set('system.high_memory', Date.now());
        await this.agentNotifyService.notify(
          'system.high_memory',
          { usagePercent: load.percentUsedMemory, availableMb: load.memoryTotal * (1 - load.percentUsedMemory / 100) },
          'medium',
        );
      }
    } catch (error) {
      // Health check failure should not crash the service but should be logged
      this.agentNotifyService
        .notify('system.health_check_failed', { error: error instanceof Error ? error.message : 'Unknown error' }, 'low')
        .catch(() => {
          // fire-and-forget
        });
    }
  }

  private isHealthEventDebounced(event: string): boolean {
    const lastEmit = this.healthDebounceMap.get(event);
    if (!lastEmit) return false;
    return Date.now() - lastEmit < this.healthDebounceMs;
  }

  /** Exposed for testing */
  _getHealthDebounceMap(): Map<string, number> {
    return this.healthDebounceMap;
  }

  _setHealthDebounceMs(ms: number): void {
    this.healthDebounceMs = ms;
  }
}
