import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { describeHubPoolDisabled, describeHubPoolInboundRefused } from '@/common/helpers/hub-pool';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { HubManagerGuard } from '@/modules/auth/hub-manager.guard';
import { PoolPeerGuard } from '@/modules/hub-pool/guards/pool-peer.guard';
import { HubPoolPeerService } from '@/modules/hub-pool/hub-pool-peer.service';
import { isPairingIncomplete } from '@/modules/hub-pool/hub-pool.types';
import { TrainingJobManifestBody } from './training.dto';
import type { TrainingJobStatus, TrainingPeerCapability } from './training.types';
import { TrainingRunnerService } from './training-runner.service';
import { TrainingPoolService } from './training-pool.service';
import { TrainingGovernorService } from './training-governor.service';

/**
 * Training jobs on this Hub, and offload to its pool peers.
 *
 * The routes answer two different callers and are guarded apart, the way `HubPoolController` is. The
 * operator routes need a signed-in user (`AuthGuard`), and the ones that start or stop work also need
 * someone who may manage the Hub (`HubManagerGuard`). The `pool/*` routes answer other Hubs: they are
 * guarded by `PoolPeerGuard`, then by {@link TrainingController.admitPeer}.
 */
@Controller('training')
export class TrainingController {
  constructor(
    private readonly runner: TrainingRunnerService,
    private readonly pool: TrainingPoolService,
    private readonly governor: TrainingGovernorService,
    // Appended last so the tests that construct this controller positionally keep their meaning.
    private readonly peerService: HubPoolPeerService,
  ) {}

  // ── Local Operator & Client Endpoints ─────────────────────────────────────

  @UseGuards(AuthGuard, HubManagerGuard)
  @Post('jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  async submitTrainingJob(@Body() manifest: TrainingJobManifestBody): Promise<TrainingJobStatus> {
    // Checked before choosing where the job runs, so an id already queued or running here is refused
    // whether this job would have stayed local or gone to a peer.
    this.runner.assertJobIdAvailable(manifest.jobId);

    // If manifest allows offload, check if local capacity is tight and peer is available
    if (manifest.resourcePolicy.allowRemoteOffload) {
      const localCapacity = await this.governor.evaluateLocalCapacity(manifest.resourcePolicy.maxVramMb ?? 4096, manifest.resourcePolicy.priority);

      if (!localCapacity.canExecuteLocal) {
        const targetPeer = await this.pool.selectOffloadPeer(manifest.resourcePolicy.maxVramMb ?? 4096);
        if (targetPeer) {
          return this.pool.dispatchJobToPeer(targetPeer.nodeFqdn, manifest);
        }
      }
    }

    // Default: execute locally
    return this.runner.submitJob(manifest);
  }

  @UseGuards(AuthGuard)
  @Get('jobs')
  listTrainingJobs(): TrainingJobStatus[] {
    return this.runner.listJobs();
  }

  @UseGuards(AuthGuard)
  @Get('jobs/:id')
  getTrainingJob(@Param('id') id: string): TrainingJobStatus {
    const status = this.runner.getJobStatus(id);
    if (!status) {
      throw new NotFoundException(`Training job ${id} not found`);
    }
    return status;
  }

  @UseGuards(AuthGuard, HubManagerGuard)
  @Post('jobs/:id/cancel')
  cancelTrainingJob(@Param('id') id: string): { cancelled: boolean } {
    return { cancelled: this.runner.cancelJob(id) };
  }

  /** Probes every peer this node may offload to, like hub-pool's `peers/discoverable`, so not a route to poll. */
  @UseGuards(AuthGuard)
  @Get('pool/peers')
  async listTrainingPeers(): Promise<TrainingPeerCapability[]> {
    return this.pool.discoverTrainingPeers();
  }

  // ── Peer-Facing Pool Ingress Endpoints (PoolPeerGuard, then admitPeer) ────

  @UseGuards(PoolPeerGuard)
  @Get('pool/capabilities')
  async getPeerCapabilities(@Req() req: Request): Promise<TrainingPeerCapability> {
    this.admitPeer(req);
    return this.pool.getLocalTrainingCapability();
  }

  @UseGuards(PoolPeerGuard)
  @Post('pool/jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  async receivePeerJob(@Req() req: Request, @Body() manifest: TrainingJobManifestBody): Promise<TrainingJobStatus> {
    this.admitPeer(req);
    // A peer dispatched this job to us — execute locally
    return this.runner.submitJob(manifest);
  }

  @UseGuards(PoolPeerGuard)
  @Get('pool/jobs/:id')
  getPeerJobStatus(@Req() req: Request, @Param('id') id: string): TrainingJobStatus {
    this.admitPeer(req);
    const status = this.runner.getJobStatus(id);
    if (!status) {
      throw new NotFoundException(`Training job ${id} not found`);
    }
    return status;
  }

  /**
   * What `PoolPeerGuard` leaves to the handler, checked in the order `HubPoolController` checks it.
   * The guard proves which peer is calling and nothing more: it admits a pairing the operator has
   * not approved yet, because `pair/confirm` has to authenticate one.
   *
   *   1. The pool is switched off here: 503.
   *   2. The pairing is incomplete: 403. {@link isPairingIncomplete}, not `status !== 'connected'`,
   *      for the reason given there: a peer this node marked unreachable is still paired.
   *   3. Inbound pooling is off, or the operator disabled this peer: 503, as on hub-pool's `local/*`
   *      forwards. 403 stays reserved for a pairing problem, and this is a decision the operator can
   *      reverse. Hub-pool's `capabilities` answers this case with a 200 that accepts no work, because
   *      that route is the pool's health probe. This one is not: a refusal only takes this node out of
   *      the caller's offload choice, and its free memory is not reported to a peer it will not work for.
   */
  private admitPeer(req: Request): void {
    const enabled = this.peerService.enabledState();
    if (!enabled.enabled) {
      throw new ServiceUnavailableException(describeHubPoolDisabled(enabled.disabledBy));
    }
    const peer = req.poolPeer;
    if (!peer || isPairingIncomplete(peer.status)) {
      throw new ForbiddenException('Peer is not connected');
    }
    const refusal = this.peerService.inboundRefusal(peer);
    if (refusal) {
      throw new ServiceUnavailableException(describeHubPoolInboundRefused(refusal));
    }
  }
}
