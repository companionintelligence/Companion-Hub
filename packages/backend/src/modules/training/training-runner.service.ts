import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { TRAINING_JOB_ID_PATTERN, type TrainingJobManifest, type TrainingJobStatus, type TrainingProgressEvent } from './training.types';
import { TrainingGovernorService } from './training-governor.service';
import { trainingChildEnv } from './training-child-env';

/** `Number.isFinite` as a type guard. `JSON.parse` reads `1e400` as Infinity, which a `typeof` check alone passes. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

@Injectable()
export class TrainingRunnerService {
  private readonly logger = new Logger(TrainingRunnerService.name);
  private readonly activeProcesses = new Map<string, ChildProcess>();
  private readonly jobStatuses = new Map<string, TrainingJobStatus>();
  /** Ids whose lifecycle has not returned yet. See {@link assertJobIdAvailable}. */
  private readonly lifecycles = new Set<string>();
  /**
   * The pool peer, by `hub_pool_peer.id`, that dispatched each job it sent here. A job this Hub's
   * operator submitted has no entry. See {@link getPeerJobStatus}.
   */
  private readonly peerSubmitters = new Map<string, string>();
  public readonly events = new EventEmitter();

  constructor(private readonly governor: TrainingGovernorService) {}

  /**
   * Submit and start executing a training job locally.
   *
   * `fromPeerId` is the `hub_pool_peer.id` of the pool peer that dispatched the job here. It is left
   * out for a job this Hub's operator submitted.
   */
  async submitJob(manifest: TrainingJobManifest, fromPeerId?: string): Promise<TrainingJobStatus> {
    const jobId = manifest.jobId;
    if (!TRAINING_JOB_ID_PATTERN.test(jobId)) {
      throw new BadRequestException(`Invalid jobId "${jobId}": must contain only alphanumeric characters, dashes, and underscores`);
    }
    this.assertJobIdAvailable(jobId);

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
    // Written with the status, so an id used again once its job has ended belongs to whoever used it last.
    if (fromPeerId === undefined) {
      this.peerSubmitters.delete(jobId);
    } else {
      this.peerSubmitters.set(jobId, fromPeerId);
    }
    this.lifecycles.add(jobId);

    // Run async execution in background
    void this.executeJobLifecycle(manifest);

    return initialStatus;
  }

  /**
   * Refuses, with 409, an id whose job is still queued or running.
   *
   * Accepting it would replace the first job's status while its lifecycle carried on, and overwrite
   * its process handle, leaving a trainer nothing can cancel. The test is the lifecycle rather than
   * the state, because a job cancelled while it waits for resources is marked `CANCELLED` before its
   * lifecycle reaches the next point that notices. Once a job has completed, failed, been cancelled
   * or been deferred, its id may be used again.
   */
  assertJobIdAvailable(jobId: string): void {
    if (this.lifecycles.has(jobId)) {
      throw new ConflictException(`Training job ${jobId} is already queued or running`);
    }
  }

  getJobStatus(jobId: string): TrainingJobStatus | undefined {
    return this.jobStatuses.get(jobId);
  }

  /**
   * A job's status as the pool peer `peerId` may read it: only for a job that peer dispatched here.
   * A local job or another peer's job reads as no job at all, the same answer as an id never used.
   */
  getPeerJobStatus(jobId: string, peerId: string): TrainingJobStatus | undefined {
    return this.peerSubmitters.get(jobId) === peerId ? this.jobStatuses.get(jobId) : undefined;
  }

  listJobs(): TrainingJobStatus[] {
    return Array.from(this.jobStatuses.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  cancelJob(jobId: string): boolean {
    const status = this.jobStatuses.get(jobId);
    if (!status) return false;

    const process = this.activeProcesses.get(jobId);
    if (process) {
      this.logger.log(`Cancelling active training process for job ${jobId}`);
      this.updateState(jobId, 'CANCELLED');
      process.kill('SIGTERM');
      this.activeProcesses.delete(jobId);
      return true;
    }

    if (status.state === 'QUEUED' || status.state === 'ACQUIRING_RESOURCES' || status.state === 'DATA_STAGING') {
      this.logger.log(`Cancelling pending training job ${jobId}`);
      this.updateState(jobId, 'CANCELLED');
      return true;
    }

    return false;
  }

  private async executeJobLifecycle(manifest: TrainingJobManifest): Promise<void> {
    const jobId = manifest.jobId;

    try {
      if (this.jobStatuses.get(jobId)?.state === 'CANCELLED') {
        return;
      }

      // 1. Acquire Resources & Check VRAM
      this.updateState(jobId, 'ACQUIRING_RESOURCES');
      const capacity = await this.governor.evaluateLocalCapacity(manifest.resourcePolicy.maxVramMb ?? 4096, manifest.resourcePolicy.priority);

      if (!capacity.canExecuteLocal) {
        if (capacity.recommendedAction === 'EVICT_INFERENCE') {
          await this.governor.evictIdleInferenceModels();
        } else if (capacity.recommendedAction === 'DEFER') {
          this.logger.log(`Deferring training job ${jobId}: ${capacity.reason}`);
          this.updateState(jobId, 'DEFERRED', { errorMessage: capacity.reason });
          return;
        } else {
          throw new Error(`Cannot run locally: ${capacity.reason}`);
        }
      }

      if (this.jobStatuses.get(jobId)?.state === 'CANCELLED') {
        return;
      }

      // 2. Data Staging
      this.updateState(jobId, 'DATA_STAGING');
      const artifactsDir = path.resolve(process.cwd(), '.internal/training', jobId);
      fs.mkdirSync(artifactsDir, { recursive: true });

      const manifestPath = path.join(artifactsDir, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

      if (this.jobStatuses.get(jobId)?.state === 'CANCELLED') {
        return;
      }

      // 3. Execution (Running)
      this.updateState(jobId, 'RUNNING');
      await this.spawnTrainingProcess(manifest, manifestPath, artifactsDir);

      if (this.jobStatuses.get(jobId)?.state === 'CANCELLED') {
        return;
      }

      // 4. Completed
      this.updateState(jobId, 'COMPLETED', {
        artifacts: {
          modelPath: path.join(artifactsDir, 'hmt_checkpoint.pt'),
          metricsSummaryPath: path.join(artifactsDir, 'metrics.json'),
        },
      });
      this.logger.log(`Training job ${jobId} completed successfully`);
    } catch (err) {
      if (this.jobStatuses.get(jobId)?.state === 'CANCELLED') {
        this.logger.log(`Training job ${jobId} cancelled successfully`);
        return;
      }
      const errorMsg = (err as Error).message;
      this.logger.error(`Training job ${jobId} failed: ${errorMsg}`);
      this.updateState(jobId, 'FAILED', { errorMessage: errorMsg });
    } finally {
      this.activeProcesses.delete(jobId);
      this.lifecycles.delete(jobId);
    }
  }

  private spawnTrainingProcess(manifest: TrainingJobManifest, manifestPath: string, artifactsDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const jobId = manifest.jobId;
      const datasetPath = path.resolve(manifest.dataset.dataPath);

      // Call the headless train_runner
      const args = ['-m', 'ci.hbpe.model.train_runner', '--manifest', manifestPath, '--dataset', datasetPath, '--output', artifactsDir];

      this.logger.log(`Spawning python3 ${args.join(' ')}`);
      // The trainer runs with the allowlisted environment only. See training-child-env.ts.
      const child = spawn('python3', args, {
        env: trainingChildEnv(),
      });

      this.activeProcesses.set(jobId, child);

      let stdoutBuffer = '';
      child.stdout.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
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
        if (this.jobStatuses.get(jobId)?.state === 'CANCELLED') {
          resolve();
          return;
        }
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
    if (!status || typeof payload !== 'object' || payload === null) return;

    // The payload is parsed from the trainer's stdout, so its types are not trusted. A peer reads this
    // status, so a field is copied only when it holds a finite number, or null for the validation loss.
    const { epoch, totalEpochs } = payload;
    if (isFiniteNumber(epoch) && isFiniteNumber(totalEpochs) && totalEpochs > 0) {
      status.currentEpoch = epoch;
      status.totalEpochs = totalEpochs;
      // A huge epoch over a tiny total overflows to Infinity. That percentage is skipped, and the last one kept.
      const percent = Math.round((epoch / totalEpochs) * 100);
      if (Number.isFinite(percent)) status.progressPercent = percent;
    }
    if (isFiniteNumber(payload.trainLoss)) status.trainLoss = payload.trainLoss;
    if (payload.valLoss === null || isFiniteNumber(payload.valLoss)) status.valLoss = payload.valLoss;
    if (isFiniteNumber(payload.etaSeconds)) status.etaSeconds = payload.etaSeconds;
    status.updatedAt = new Date().toISOString();

    const progressEvent: TrainingProgressEvent = {
      jobId,
      phase: payload.phase ?? 'training',
      epoch: status.currentEpoch,
      totalEpochs: status.totalEpochs,
      trainLoss: status.trainLoss,
      valLoss: status.valLoss,
      learningRate: isFiniteNumber(payload.learningRate) ? payload.learningRate : 0,
      elapsedSeconds: isFiniteNumber(payload.elapsedSeconds) ? payload.elapsedSeconds : 0,
      etaSeconds: status.etaSeconds,
      device: payload.device ?? 'unknown',
      timestamp: status.updatedAt,
    };

    this.events.emit(`progress.${jobId}`, progressEvent);
  }

  private updateState(jobId: string, state: TrainingJobStatus['state'], extra: Partial<TrainingJobStatus> = {}): void {
    const current = this.jobStatuses.get(jobId);
    if (current) {
      current.state = state;
      current.updatedAt = new Date().toISOString();
      Object.assign(current, extra);
      this.events.emit(`status.${jobId}`, current);
    }
  }
}
