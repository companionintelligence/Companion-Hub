import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type {
  TrainingJobManifest,
  TrainingJobStatus,
  TrainingPeerCapability,
} from './training.types';
import { TrainingRunnerService } from './training-runner.service';
import { TrainingPoolService } from './training-pool.service';
import { TrainingGovernorService } from './training-governor.service';
import { PoolPeerGuard } from '@/modules/hub-pool/guards/pool-peer.guard';

@Controller('training')
export class TrainingController {
  constructor(
    private readonly runner: TrainingRunnerService,
    private readonly pool: TrainingPoolService,
    private readonly governor: TrainingGovernorService,
  ) {}

  // ── Local Operator & Client Endpoints ─────────────────────────────────────

  @Post('jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  async submitTrainingJob(
    @Body() manifest: TrainingJobManifest,
  ): Promise<TrainingJobStatus> {
    // If manifest allows offload, check if local capacity is tight and peer is available
    if (manifest.resourcePolicy.allowRemoteOffload) {
      const localCapacity = await this.governor.evaluateLocalCapacity(
        manifest.resourcePolicy.maxVramMb ?? 4096,
        manifest.resourcePolicy.priority,
      );

      if (!localCapacity.canExecuteLocal) {
        const targetPeer = await this.pool.selectOffloadPeer(
          manifest.resourcePolicy.maxVramMb ?? 4096,
        );
        if (targetPeer) {
          return this.pool.dispatchJobToPeer(targetPeer.nodeFqdn, manifest);
        }
      }
    }

    // Default: execute locally
    return this.runner.submitJob(manifest);
  }

  @Get('jobs')
  listTrainingJobs(): TrainingJobStatus[] {
    return this.runner.listJobs();
  }

  @Get('jobs/:id')
  getTrainingJob(@Param('id') id: string): TrainingJobStatus {
    const status = this.runner.getJobStatus(id);
    if (!status) {
      throw new NotFoundException(`Training job ${id} not found`);
    }
    return status;
  }

  @Post('jobs/:id/cancel')
  cancelTrainingJob(@Param('id') id: string): { cancelled: boolean } {
    return { cancelled: this.runner.cancelJob(id) };
  }

  @Get('pool/peers')
  async listTrainingPeers(): Promise<TrainingPeerCapability[]> {
    return this.pool.discoverTrainingPeers();
  }

  // ── Peer-Facing Pool Ingress Endpoints (Guarded by PoolPeerGuard) ─────────

  @Get('pool/capabilities')
  @UseGuards(PoolPeerGuard)
  async getPeerCapabilities(): Promise<TrainingPeerCapability> {
    return this.pool.getLocalTrainingCapability();
  }

  @Post('pool/jobs')
  @UseGuards(PoolPeerGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  async receivePeerJob(
    @Body() manifest: TrainingJobManifest,
  ): Promise<TrainingJobStatus> {
    // A peer dispatched this job to us — execute locally
    return this.runner.submitJob(manifest);
  }

  @Get('pool/jobs/:id')
  @UseGuards(PoolPeerGuard)
  getPeerJobStatus(@Param('id') id: string): TrainingJobStatus {
    const status = this.runner.getJobStatus(id);
    if (!status) {
      throw new NotFoundException(`Training job ${id} not found`);
    }
    return status;
  }
}
