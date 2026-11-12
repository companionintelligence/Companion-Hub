import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { HubPoolPeerService } from '@/modules/hub-pool/hub-pool-peer.service';
import type { TrainingJobManifest, TrainingJobStatus, TrainingPeerCapability } from './training.types';
import { TrainingRunnerService } from './training-runner.service';
import { TrainingGovernorService } from './training-governor.service';

/**
 * The peer-facing training routes, as sent. A signed request covers the path, `/api` included, and the
 * receiving guard checks it against the path it was reached on, so these are not built anywhere else.
 */
const TRAINING_POOL_CAPABILITIES_PATH = '/api/training/pool/capabilities';
const TRAINING_POOL_JOBS_PATH = '/api/training/pool/jobs';

@Injectable()
export class TrainingPoolService {
  private readonly logger = new Logger(TrainingPoolService.name);

  constructor(
    private readonly peerService: HubPoolPeerService,
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
      supportedFrameworks: ['pytorch', 'onnx', 'mlx', 'unsloth'],
      activeTrainingJobs: this.runner.listJobs().filter((j) => j.state === 'RUNNING').length,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Query the peers this node may send work to for their training capacity.
   */
  async discoverTrainingPeers(): Promise<TrainingPeerCapability[]> {
    const peers = await this.usablePeers();
    const results: TrainingPeerCapability[] = [];

    for (const peer of peers) {
      try {
        const response = await fetch(`https://${peer.nodeFqdn}${TRAINING_POOL_CAPABILITIES_PATH}`, {
          method: 'GET',
          headers: await this.peerService.peerAuthHeaders(peer, 'GET', TRAINING_POOL_CAPABILITIES_PATH),
          signal: AbortSignal.timeout(3000),
        });

        if (response.ok) {
          const cap = (await response.json()) as TrainingPeerCapability;
          cap.nodeFqdn = peer.nodeFqdn;
          results.push(cap);
        }
      } catch (err) {
        this.logger.debug(`Peer ${peer.nodeFqdn} does not support training pool or is unreachable: ${(err as Error).message}`);
      }
    }

    return results;
  }

  /**
   * Select best peer for training offload based on available VRAM and tier.
   */
  async selectOffloadPeer(requiredVramMb = 4096): Promise<TrainingPeerCapability | null> {
    const peers = await this.discoverTrainingPeers();
    const eligible = peers.filter((p) => p.acceptingTrainingJobs && p.availableVramMb >= requiredVramMb && p.activeTrainingJobs === 0);

    if (eligible.length === 0) return null;

    // Sort by highest available VRAM
    eligible.sort((a, b) => b.availableVramMb - a.availableVramMb);
    return eligible[0] ?? null;
  }

  /**
   * Dispatch a training job to a selected remote peer across the tailnet.
   */
  async dispatchJobToPeer(peerFqdn: string, manifest: TrainingJobManifest): Promise<TrainingJobStatus> {
    // Looked up among the usable peers, not by name alone, so a peer switched off between discovery
    // and dispatch is not sent the job.
    const peer = (await this.usablePeers()).find((candidate) => candidate.nodeFqdn === peerFqdn);
    if (!peer) {
      throw new NotFoundException(`Peer ${peerFqdn} is not a connected pool peer this node may send work to`);
    }

    // The body is signed along with the path, so the object signed is the one serialized below.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(await this.peerService.peerAuthHeaders(peer, 'POST', TRAINING_POOL_JOBS_PATH, manifest)),
    };

    this.logger.log(`Dispatching training job ${manifest.jobId} to peer ${peer.nodeFqdn}`);
    const response = await fetch(`https://${peer.nodeFqdn}${TRAINING_POOL_JOBS_PATH}`, {
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

  /**
   * The peers this node may send training work to: connected, not switched off by the operator, and
   * none at all while outbound pooling (or the pool) is off. The rule hub-pool's proxy applies before
   * it routes inference to a peer (`PoolProxyService.usablePeers`).
   */
  private async usablePeers(): Promise<HubPoolPeer[]> {
    if (!this.peerService.directions().outbound.enabled) {
      return [];
    }
    // `!== false`: the column is NOT NULL DEFAULT true, so only an operator's decision removes a peer.
    return (await this.peerService.listConnectedPeers()).filter((peer) => peer.enabled !== false);
  }
}
