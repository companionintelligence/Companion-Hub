import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type {
  TrainingJobManifest,
  TrainingJobStatus,
  TrainingProgressEvent,
} from './training.types';
import { TrainingGovernorService } from './training-governor.service';

@Injectable()
export class TrainingRunnerService {
  private readonly logger = new Logger(TrainingRunnerService.name);
  private readonly activeProcesses = new Map<string, ChildProcess>();
  private readonly jobStatuses = new Map<string, TrainingJobStatus>();
  public readonly events = new EventEmitter();

  constructor(
    private readonly governor: TrainingGovernorService,
  ) {}

  /**
   * Submit and start executing a training job locally.
   */
  async submitJob(manifest: TrainingJobManifest): Promise<TrainingJobStatus> {
    const jobId = manifest.jobId;
    const now = new Date().toISOString();

    const initialStatus: TrainingJobStatus = {
      jobId,
      appId: manifest.appId,
      jobType: manifest.jobType,
      state: 'QUEUED',
      executedOnNode: 'local',
      currentEpoch: 0,
      totalEpochs: manifest.hyperparameters.epochs,
      trainLoss: 0,
      valLoss: null,
      progressPercent: 0,
      etaSeconds: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.jobStatuses.set(jobId, initialStatus);

    // Run async execution in background
    void this.executeJobLifecycle(manifest);

    return initialStatus;
  }

  getJobStatus(jobId: string): TrainingJobStatus | undefined {
    return this.jobStatuses.get(jobId);
  }

  listJobs(): TrainingJobStatus[] {
    return Array.from(this.jobStatuses.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  cancelJob(jobId: string): boolean {
    const process = this.activeProcesses.get(jobId);
    if (process) {
      this.logger.log(`Cancelling training process for job ${jobId}`);
      process.kill('SIGTERM');
      this.activeProcesses.delete(jobId);
      this.updateState(jobId, 'CANCELLED');
      return true;
    }
    return false;
  }

  private async executeJobLifecycle(manifest: TrainingJobManifest): Promise<void> {
    const jobId = manifest.jobId;

    try {
      // 1. Acquire Resources & Check VRAM
      this.updateState(jobId, 'ACQUIRING_RESOURCES');
      const capacity = await this.governor.evaluateLocalCapacity(
        manifest.resourcePolicy.maxVramMb ?? 4096,
        manifest.resourcePolicy.priority,
      );

      if (!capacity.canExecuteLocal) {
        if (capacity.recommendedAction === 'EVICT_INFERENCE') {
          await this.governor.evictIdleInferenceModels();
        } else {
          throw new Error(`Cannot run locally: ${capacity.reason}`);
        }
      }

      // 2. Data Staging
      this.updateState(jobId, 'DATA_STAGING');
      const artifactsDir = path.resolve(process.cwd(), '.internal/training', jobId);
      fs.mkdirSync(artifactsDir, { recursive: true });

      const manifestPath = path.join(artifactsDir, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

      // 3. Execution (Running)
      this.updateState(jobId, 'RUNNING');
      await this.spawnTrainingProcess(manifest, manifestPath, artifactsDir);

      // 4. Completed
      this.updateState(jobId, 'COMPLETED', {
        artifacts: {
          modelPath: path.join(artifactsDir, 'hmt_checkpoint.pt'),
          metricsSummaryPath: path.join(artifactsDir, 'metrics.json'),
        },
      });
      this.logger.log(`Training job ${jobId} completed successfully`);
    } catch (err) {
      const errorMsg = (err as Error).message;
      this.logger.error(`Training job ${jobId} failed: ${errorMsg}`);
      this.updateState(jobId, 'FAILED', { errorMessage: errorMsg });
    } finally {
      this.activeProcesses.delete(jobId);
    }
  }

  private spawnTrainingProcess(
    manifest: TrainingJobManifest,
    manifestPath: string,
    artifactsDir: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const jobId = manifest.jobId;
      const datasetPath = path.resolve(manifest.dataset.dataPath);

      // Call the headless train_runner
      const args = [
        '-m',
        'ci.hbpe.model.train_runner',
        '--manifest',
        manifestPath,
        '--dataset',
        datasetPath,
        '--output',
        artifactsDir,
      ];

      this.logger.log(`Spawning python3 ${args.join(' ')}`);
      const child = spawn('python3', args, {
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });

      this.activeProcesses.set(jobId, child);

      child.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        for (const line of text.split('\n')) {
          if (line.startsWith('CI_TRAIN_EVENT:')) {
            try {
              const payload = JSON.parse(line.replace('CI_TRAIN_EVENT:', '').trim());
              this.handleProgressEvent(jobId, payload);
            } catch {
              // Ignore malformed json lines
            }
          }
        }
      });

      child.stderr.on('data', (data: Buffer) => {
        this.logger.debug(`[${jobId} stderr] ${data.toString().trim()}`);
      });

      child.on('error', (err) => {
        reject(err);
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Training runner exited with code ${code}`));
        }
      });
    });
  }

  private handleProgressEvent(jobId: string, payload: Partial<TrainingProgressEvent>): void {
    const status = this.jobStatuses.get(jobId);
    if (!status) return;

    if (payload.epoch !== undefined && payload.totalEpochs !== undefined) {
      status.currentEpoch = payload.epoch;
      status.totalEpochs = payload.totalEpochs;
      status.progressPercent = Math.round((payload.epoch / payload.totalEpochs) * 100);
    }
    if (payload.trainLoss !== undefined) status.trainLoss = payload.trainLoss;
    if (payload.valLoss !== undefined) status.valLoss = payload.valLoss;
    if (payload.etaSeconds !== undefined) status.etaSeconds = payload.etaSeconds;
    status.updatedAt = new Date().toISOString();

    const progressEvent: TrainingProgressEvent = {
      jobId,
      phase: payload.phase ?? 'training',
      epoch: status.currentEpoch,
      totalEpochs: status.totalEpochs,
      trainLoss: status.trainLoss,
      valLoss: status.valLoss,
      learningRate: payload.learningRate ?? 0,
      elapsedSeconds: payload.elapsedSeconds ?? 0,
      etaSeconds: status.etaSeconds,
      device: payload.device ?? 'unknown',
      timestamp: status.updatedAt,
    };

    this.events.emit(`progress.${jobId}`, progressEvent);
  }

  private updateState(
    jobId: string,
    state: TrainingJobStatus['state'],
    extra: Partial<TrainingJobStatus> = {},
  ): void {
    const current = this.jobStatuses.get(jobId);
    if (current) {
      current.state = state;
      current.updatedAt = new Date().toISOString();
      Object.assign(current, extra);
      this.events.emit(`status.${jobId}`, current);
    }
  }
}
