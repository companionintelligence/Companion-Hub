import { Injectable, Logger } from '@nestjs/common';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import { trainingChildEnv } from './training-child-env';

const execAsync = promisify(exec);

export interface GovernorCheckResult {
  canExecuteLocal: boolean;
  reason?: string;
  recommendedAction?: 'PROCEED' | 'OFFLOAD' | 'DEFER' | 'EVICT_INFERENCE';
}

@Injectable()
export class TrainingGovernorService {
  private readonly logger = new Logger(TrainingGovernorService.name);

  /**
   * Evaluates whether a training job can run locally right now without causing
   * VRAM exhaustion, battery drain, or thermal throttling.
   */
  async evaluateLocalCapacity(requiredVramMb = 4096, priority = 'normal'): Promise<GovernorCheckResult> {
    // 1. Battery check (macOS & Linux laptops)
    const onBattery = await this.isOnBattery();
    if (onBattery && priority !== 'interactive') {
      return {
        canExecuteLocal: false,
        reason: 'Device running on battery power; deferring background training',
        recommendedAction: 'DEFER',
      };
    }

    // 2. High thermal condition
    const isThermalThrottled = await this.checkThermalState();
    if (isThermalThrottled) {
      return {
        canExecuteLocal: false,
        reason: 'Hardware thermal limit exceeded (>90°C); throttling compute',
        recommendedAction: 'OFFLOAD',
      };
    }

    // 3. Local VRAM Headroom
    const availableVramMb = await this.getEstimatedAvailableVramMb();
    if (availableVramMb < requiredVramMb) {
      return {
        canExecuteLocal: false,
        reason: `Insufficient free VRAM (${availableVramMb}MB available, ${requiredVramMb}MB required)`,
        recommendedAction: 'EVICT_INFERENCE',
      };
    }

    return { canExecuteLocal: true, recommendedAction: 'PROCEED' };
  }

  /**
   * Temporarily evicts resident models from Ollama to reclaim GPU/unified memory.
   */
  async evictIdleInferenceModels(): Promise<boolean> {
    try {
      this.logger.log('Signaling local Ollama to evict resident models (keep_alive: 0)...');
      const response = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: '', keep_alive: 0 }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);

      if (response?.ok) {
        this.logger.log('Successfully evicted idle Ollama models from VRAM');
        return true;
      }
    } catch (err) {
      this.logger.warn(`Failed to evict inference models: ${(err as Error).message}`);
    }
    return false;
  }

  /**
   * Estimate available VRAM (MB) across Apple Silicon unified memory or NVIDIA CUDA.
   */
  async getEstimatedAvailableVramMb(): Promise<number> {
    // Check macOS unified memory via sysctl / vm_stat
    if (process.platform === 'darwin') {
      try {
        const { stdout } = await execAsync('sysctl -n hw.memsize', { env: trainingChildEnv() });
        const totalBytes = Number.parseInt(stdout.trim(), 10);
        // On Apple Silicon, unified memory is shared; estimate ~50% usable for training safely
        return Math.floor((totalBytes / (1024 * 1024)) * 0.5);
      } catch {
        return 8192; // Fallback
      }
    }

    // Check Linux / NVIDIA via nvidia-smi
    if (process.platform === 'linux') {
      try {
        const { stdout } = await execAsync('nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits', { env: trainingChildEnv() });
        const firstLine = stdout.split('\n')[0] ?? '';
        const firstGpuFree = Number.parseInt(firstLine.trim(), 10);
        if (!Number.isNaN(firstGpuFree)) {
          return firstGpuFree;
        }
      } catch {
        // Fallback to system RAM
      }
    }

    return 4096;
  }

  private async isOnBattery(): Promise<boolean> {
    if (process.platform === 'darwin') {
      try {
        const { stdout } = await execAsync('pmset -g batt', { env: trainingChildEnv() });
        return stdout.includes("Now drawing from 'Battery Power'");
      } catch {
        return false;
      }
    }

    if (process.platform === 'linux') {
      try {
        if (fs.existsSync('/sys/class/power_supply/BAT0/status')) {
          const status = fs.readFileSync('/sys/class/power_supply/BAT0/status', 'utf-8').trim();
          return status === 'Discharging';
        }
      } catch {
        return false;
      }
    }

    return false;
  }

  private async checkThermalState(): Promise<boolean> {
    if (process.platform === 'darwin') {
      try {
        const { stdout } = await execAsync('pmset -g therm', { env: trainingChildEnv() });
        const match = stdout.match(/CPU_Speed_Limit\s*=\s*(\d+)/);
        const limitStr = match?.[1];
        if (limitStr) {
          return Number.parseInt(limitStr, 10) < 100;
        }
        return false;
      } catch {
        return false;
      }
    }
    return false;
  }
}
