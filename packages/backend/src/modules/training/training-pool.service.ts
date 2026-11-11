import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  TrainingJobManifest,
  TrainingJobStatus,
  TrainingPeerCapability,
} from './training.types';
import { HubPoolPeerRepository } from '@/modules/hub-pool/hub-pool-peer.repository';
import { HubPoolIdentityService } from '@/modules/hub-pool/hub-pool-identity.service';
import { TrainingRunnerService } from './training-runner.service';
import { TrainingGovernorService } from './training-governor.service';

@Injectable()
export class TrainingPoolService {
  private readonly logger = new Logger(TrainingPoolService.name);

  constructor(
    private readonly peerRepo: HubPoolPeerRepository,
    private readonly identityService: HubPoolIdentityService,
    private readonly runner: TrainingRunnerService,
    private readonly governor: TrainingGovernorService,
  ) {}

  /**
   * Reports this local node's training capability to peer queries.
   */
  async getLocalTrainingCapability(): Promise<TrainingPeerCapability> {
    const vramMb = await this.governor.getEstimatedAvailableVramMb();
    return {
      nodeFqdn: 'local',
      hardwareTier: vramMb >= 16000 ? 'High-end' : vramMb >= 8000 ? 'Mid-range' : 'CPU only',
      acceptingTrainingJobs: vramMb >= 4096,
      availableVramMb: vramMb,
      gpuPressure: 0,
      supportedFrameworks: ['pytorch', 'onnx', 'mlx'],
      activeTrainingJobs: this.runner.listJobs().filter((j) => j.state === 'RUNNING').length,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Query all connected peers in Hub Pool to discover available training capacity.
   */
  async discoverTrainingPeers(): Promise<TrainingPeerCapability[]> {
    const peers = await this.peerRepo.listByStatus('connected');
    const results: TrainingPeerCapability[] = [];

    for (const peer of peers) {
      try {
        const url = `https://${peer.nodeFqdn}/api/training/pool/capabilities`;
        const headers: Record<string, string> = {};
        if (peer.outboundBearerToken) {
          headers.Authorization = `Bearer ${peer.outboundBearerToken}`;
        }

        const response = await fetch(url, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(3000),
        });

        if (response.ok) {
          const cap = (await response.json()) as TrainingPeerCapability;
          cap.nodeFqdn = peer.nodeFqdn;
          results.push(cap);
        }
      } catch (err) {
        this.logger.debug(
          `Peer ${peer.nodeFqdn} does not support training pool or is unreachable: ${(err as Error).message}`,
        );
      }
    }

    return results;
  }

  /**
   * Select best peer for training offload based on available VRAM and tier.
   */
  async selectOffloadPeer(requiredVramMb: number = 4096): Promise<TrainingPeerCapability | null> {
    const peers = await this.discoverTrainingPeers();
    const eligible = peers.filter(
      (p) => p.acceptingTrainingJobs && p.availableVramMb >= requiredVramMb && p.activeTrainingJobs === 0,
    );

    if (eligible.length === 0) return null;

    // Sort by highest available VRAM
    eligible.sort((a, b) => b.availableVramMb - a.availableVramMb);
    return eligible[0] ?? null;
  }

  /**
   * Dispatch a training job to a selected remote peer across the tailnet.
   */
  async dispatchJobToPeer(
    peerFqdn: string,
    manifest: TrainingJobManifest,
  ): Promise<TrainingJobStatus> {
    const peer = await this.peerRepo.findByNodeFqdn(peerFqdn);
    if (!peer) {
      throw new NotFoundException(`Peer ${peerFqdn} not found in paired pool peers`);
    }

    const url = `https://${peer.nodeFqdn}/api/training/pool/jobs`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (peer.outboundBearerToken) {
      headers.Authorization = `Bearer ${peer.outboundBearerToken}`;
    }

    this.logger.log(`Dispatching training job ${manifest.jobId} to peer ${peer.nodeFqdn}`);
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(manifest),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to dispatch job to peer ${peer.nodeFqdn}: ${response.status} ${errText}`);
    }

    const remoteStatus = (await response.json()) as TrainingJobStatus;
    remoteStatus.executedOnNode = peer.nodeFqdn;
    return remoteStatus;
  }
}
