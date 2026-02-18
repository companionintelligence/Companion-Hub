import { APP_DATA_DIR, DATA_DIR } from '@/common/constants';
import { QueueHealthIndicator } from '@/modules/queue/queue.health';
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import fs from 'node:fs';
import path from 'node:path';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private queueHealthIndicator: QueueHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.queueHealthIndicator.isHealthy('queue')]);
  }

  /**
   * Data integrity check — verifies that all critical data directories
   * exist and are accessible. Used by the update script to confirm
   * volumes survived container recreation.
   */
  @Get('data')
  async checkDataIntegrity() {
    const criticalPaths: Record<string, string> = {
      data: DATA_DIR,
      appData: APP_DATA_DIR,
      state: path.join(DATA_DIR, 'state'),
      apps: path.join(DATA_DIR, 'apps'),
      userConfig: path.join(DATA_DIR, 'user-config'),
    };

    const results: Record<string, { exists: boolean; writable: boolean }> = {};
    let allOk = true;

    for (const [name, dirPath] of Object.entries(criticalPaths)) {
      const exists = await fs.promises
        .access(dirPath, fs.constants.F_OK)
        .then(() => true)
        .catch(() => false);

      const writable = exists
        ? await fs.promises
            .access(dirPath, fs.constants.W_OK)
            .then(() => true)
            .catch(() => false)
        : false;

      results[name] = { exists, writable };

      if (!exists || !writable) {
        allOk = false;
      }
    }

    // Check named volume for app-data by looking for a sentinel file
    const sentinelPath = path.join(APP_DATA_DIR, '.ci-hub-initialized');
    const initialized = await fs.promises
      .access(sentinelPath)
      .then(() => true)
      .catch(() => false);

    if (!initialized) {
      // First run — create sentinel
      try {
        await fs.promises.mkdir(APP_DATA_DIR, { recursive: true });
        await fs.promises.writeFile(sentinelPath, new Date().toISOString());
      } catch {
        // Non-fatal — may not have write access
      }
    }

    return {
      ok: allOk,
      initialized,
      dirs: results,
    };
  }
}
