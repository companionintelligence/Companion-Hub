import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { TrainingGovernorService, type GovernorCheckResult } from '../training-governor.service';
import { TrainingRunnerService } from '../training-runner.service';
import { TrainingPoolService } from '../training-pool.service';
import { TrainingController } from '../training.controller';
import type { TrainingJobManifest, TrainingPeerCapability } from '../training.types';
import type { HubPoolPeerService } from '@/modules/hub-pool/hub-pool-peer.service';
import type { HubPoolPeer } from '@/core/database/drizzle/types';

function manifestFor(jobId: string): TrainingJobManifest {
  return {
    jobId,
    appId: 'ci-memory',
    jobType: 'hbpe_bootstrap_hmt',
    model: { backboneId: 'ci/hmt-v1', framework: 'pytorch', targetFormat: 'onnx_int8' },
    dataset: { format: 'token_stream_jsonl', dataPath: '/tmp/data.jsonl', valFraction: 0.15 },
    hyperparameters: { batchSize: 16, learningRate: 1e-4, epochs: 20, mixedPrecision: true },
    resourcePolicy: { devicePreference: 'cpu', allowRemoteOffload: false, priority: 'normal', timeoutSeconds: 3600 },
  };
}

describe('Training Subsystem', () => {
  describe('TrainingGovernorService', () => {
    let governor: TrainingGovernorService;

    beforeEach(() => {
      governor = new TrainingGovernorService();
    });

    it('evaluates local capacity as PROCEED when VRAM headroom is sufficient', async () => {
      vi.spyOn(governor, 'getEstimatedAvailableVramMb').mockResolvedValue(16384);
      // @ts-expect-error mocking private isOnBattery
      vi.spyOn(governor, 'isOnBattery').mockResolvedValue(false);
      // @ts-expect-error mocking private checkThermalState
      vi.spyOn(governor, 'checkThermalState').mockResolvedValue(false);

      const result = await governor.evaluateLocalCapacity(4096, 'normal');
      expect(result.canExecuteLocal).toBe(true);
      expect(result.recommendedAction).toBe('PROCEED');
    });

    it('recommends EVICT_INFERENCE when free VRAM is below required budget', async () => {
      vi.spyOn(governor, 'getEstimatedAvailableVramMb').mockResolvedValue(2048);
      // @ts-expect-error mocking private
      vi.spyOn(governor, 'isOnBattery').mockResolvedValue(false);
      // @ts-expect-error mocking private
      vi.spyOn(governor, 'checkThermalState').mockResolvedValue(false);

      const result = await governor.evaluateLocalCapacity(4096, 'normal');
      expect(result.canExecuteLocal).toBe(false);
      expect(result.recommendedAction).toBe('EVICT_INFERENCE');
      expect(result.reason).toContain('Insufficient free VRAM');
    });

    it('defers background training when running on battery power', async () => {
      vi.spyOn(governor, 'getEstimatedAvailableVramMb').mockResolvedValue(16384);
      // @ts-expect-error mocking private
      vi.spyOn(governor, 'isOnBattery').mockResolvedValue(true);
      // @ts-expect-error mocking private
      vi.spyOn(governor, 'checkThermalState').mockResolvedValue(false);

      const result = await governor.evaluateLocalCapacity(4096, 'nightly_idle');
      expect(result.canExecuteLocal).toBe(false);
      expect(result.recommendedAction).toBe('DEFER');
    });
  });

  describe('TrainingRunnerService', () => {
    let runner: TrainingRunnerService;
    let governor: TrainingGovernorService;

    beforeEach(() => {
      governor = new TrainingGovernorService();
      runner = new TrainingRunnerService(governor);
    });

    it('initializes and tracks submitted jobs', async () => {
      const manifest: TrainingJobManifest = {
        jobId: 'test-job-1',
        appId: 'ci-memory',
        jobType: 'hbpe_bootstrap_hmt',
        model: {
          backboneId: 'ci/hmt-v1',
          framework: 'pytorch',
          targetFormat: 'onnx_int8',
        },
        dataset: {
          format: 'token_stream_jsonl',
          dataPath: '/tmp/data.jsonl',
          valFraction: 0.15,
        },
        hyperparameters: {
          batchSize: 16,
          learningRate: 1e-4,
          epochs: 20,
          mixedPrecision: true,
        },
        resourcePolicy: {
          devicePreference: 'cpu',
          allowRemoteOffload: false,
          priority: 'normal',
          timeoutSeconds: 3600,
        },
      };

      const status = await runner.submitJob(manifest);
      expect(status.jobId).toBe('test-job-1');
      expect(['QUEUED', 'ACQUIRING_RESOURCES']).toContain(status.state);
      expect(status.totalEpochs).toBe(20);

      const fetched = runner.getJobStatus('test-job-1');
      expect(fetched).toBeDefined();
      expect(fetched?.jobId).toBe('test-job-1');

      const all = runner.listJobs();
      expect(all.length).toBe(1);
    });

    it('refuses a second job under an id still in flight, and frees the id once that job ends', async () => {
      const governed = mock<TrainingGovernorService>();
      let decide: (result: GovernorCheckResult) => void = () => {};
      governed.evaluateLocalCapacity.mockReturnValue(
        new Promise((resolve) => {
          decide = resolve;
        }),
      );
      const held = new TrainingRunnerService(governed);

      await held.submitJob(manifestFor('nightly'));
      await expect(held.submitJob(manifestFor('nightly'))).rejects.toBeInstanceOf(ConflictException);

      decide({ canExecuteLocal: false, recommendedAction: 'DEFER', reason: 'on battery' });
      await vi.waitFor(() => expect(held.getJobStatus('nightly')?.state).toBe('DEFERRED'));

      governed.evaluateLocalCapacity.mockReturnValue(new Promise(() => {}));
      await expect(held.submitJob(manifestFor('nightly'))).resolves.toMatchObject({ jobId: 'nightly' });
    });

    it('answers an id that cannot name a directory with a 400, not a 500', async () => {
      await expect(runner.submitJob(manifestFor('../escape'))).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('TrainingPoolService', () => {
    let poolService: TrainingPoolService;
    let peerService: MockProxy<HubPoolPeerService>;
    let runner: MockProxy<TrainingRunnerService>;
    let governor: MockProxy<TrainingGovernorService>;

    const peerA = { id: '1', nodeFqdn: 'laptop.ts.net', status: 'connected', enabled: true } as HubPoolPeer;
    const peerB = { id: '2', nodeFqdn: 'desktop-rtx4090.ts.net', status: 'connected', enabled: true } as HubPoolPeer;

    beforeEach(() => {
      peerService = mock<HubPoolPeerService>();
      runner = mock<TrainingRunnerService>();
      governor = mock<TrainingGovernorService>();

      peerService.directions.mockReturnValue({ outbound: { enabled: true, disabledBy: null }, inbound: { enabled: true, disabledBy: null } });
      peerService.listConnectedPeers.mockResolvedValue([peerA, peerB]);
      // Stands in for hub-pool's signed headers. training.controller.http.test.ts proves a real peer accepts them.
      peerService.peerAuthHeaders.mockImplementation(async (peer) => ({ 'X-Hub-Pool-Node': `node-of-${peer.nodeFqdn}` }));

      poolService = new TrainingPoolService(peerService, runner, governor);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('reports local training capability accurately', async () => {
      governor.getEstimatedAvailableVramMb.mockResolvedValue(24576);
      runner.listJobs.mockReturnValue([]);

      const cap = await poolService.getLocalTrainingCapability();
      expect(cap.hardwareTier).toBe('High-end');
      expect(cap.acceptingTrainingJobs).toBe(true);
      expect(cap.availableVramMb).toBe(24576);
    });

    it('selects the peer with the highest available VRAM when offloading', async () => {
      // Mock fetch response for both peers
      const capA: TrainingPeerCapability = {
        nodeFqdn: 'laptop.ts.net',
        hardwareTier: 'Mid-range',
        acceptingTrainingJobs: true,
        availableVramMb: 8192,
        gpuPressure: 0,
        supportedFrameworks: ['pytorch'],
        activeTrainingJobs: 0,
        lastUpdated: new Date().toISOString(),
      };

      const capB: TrainingPeerCapability = {
        nodeFqdn: 'desktop-rtx4090.ts.net',
        hardwareTier: 'High-end',
        acceptingTrainingJobs: true,
        availableVramMb: 24576,
        gpuPressure: 0,
        supportedFrameworks: ['pytorch'],
        activeTrainingJobs: 0,
        lastUpdated: new Date().toISOString(),
      };

      const globalFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('laptop.ts.net')) {
          return Promise.resolve(new Response(JSON.stringify(capA)));
        }
        if (url.includes('desktop-rtx4090.ts.net')) {
          return Promise.resolve(new Response(JSON.stringify(capB)));
        }
        return Promise.reject(new Error('unreachable'));
      });
      vi.stubGlobal('fetch', globalFetch);

      const target = await poolService.selectOffloadPeer(4096);
      expect(target).toBeDefined();
      expect(target?.nodeFqdn).toBe('desktop-rtx4090.ts.net');
      expect(target?.availableVramMb).toBe(24576);
      // Each probe carries the credentials hub-pool builds for that peer and path.
      expect(peerService.peerAuthHeaders).toHaveBeenCalledWith(peerA, 'GET', '/api/training/pool/capabilities');
      expect(globalFetch).toHaveBeenCalledWith(
        'https://laptop.ts.net/api/training/pool/capabilities',
        expect.objectContaining({ headers: { 'X-Hub-Pool-Node': 'node-of-laptop.ts.net' } }),
      );
    });

    it('probes no peer the operator disabled, and none at all while outbound pooling is off', async () => {
      const globalFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
      vi.stubGlobal('fetch', globalFetch);
      peerService.listConnectedPeers.mockResolvedValue([peerA, { ...peerB, enabled: false }]);

      await poolService.discoverTrainingPeers();
      expect(globalFetch.mock.calls.map(([url]) => url)).toEqual(['https://laptop.ts.net/api/training/pool/capabilities']);

      globalFetch.mockClear();
      peerService.directions.mockReturnValue({ outbound: { enabled: false, disabledBy: 'setting' }, inbound: { enabled: true, disabledBy: null } });
      await expect(poolService.discoverTrainingPeers()).resolves.toEqual([]);
      expect(globalFetch).not.toHaveBeenCalled();
    });

    it('will not dispatch to a peer it may no longer send work to', async () => {
      const globalFetch = vi.fn();
      vi.stubGlobal('fetch', globalFetch);
      peerService.listConnectedPeers.mockResolvedValue([{ ...peerA, enabled: false }]);

      await expect(poolService.dispatchJobToPeer('laptop.ts.net', manifestFor('offload'))).rejects.toBeInstanceOf(NotFoundException);
      expect(peerService.peerAuthHeaders).not.toHaveBeenCalled();
      expect(globalFetch).not.toHaveBeenCalled();
    });
  });

  describe('TrainingController', () => {
    let controller: TrainingController;
    let runner: MockProxy<TrainingRunnerService>;
    let pool: MockProxy<TrainingPoolService>;
    let governor: MockProxy<TrainingGovernorService>;

    beforeEach(() => {
      runner = mock<TrainingRunnerService>();
      pool = mock<TrainingPoolService>();
      governor = mock<TrainingGovernorService>();
      controller = new TrainingController(runner, pool, governor, mock<HubPoolPeerService>());
    });

    it('dispatches to peer when local capacity is insufficient and offload is allowed', async () => {
      const manifest: TrainingJobManifest = {
        jobId: 'job-offload',
        appId: 'ci-memory',
        jobType: 'hbpe_bootstrap_hmt',
        model: { backboneId: 'hmt', framework: 'pytorch', targetFormat: 'onnx_int8' },
        dataset: { format: 'token_stream_jsonl', dataPath: '/tmp/data', valFraction: 0.15 },
        hyperparameters: { batchSize: 16, learningRate: 1e-4, epochs: 10, mixedPrecision: true },
        resourcePolicy: {
          devicePreference: 'auto',
          maxVramMb: 8192,
          allowRemoteOffload: true,
          priority: 'normal',
          timeoutSeconds: 3600,
        },
      };

      governor.evaluateLocalCapacity.mockResolvedValue({
        canExecuteLocal: false,
        recommendedAction: 'OFFLOAD',
      });

      pool.selectOffloadPeer.mockResolvedValue({
        nodeFqdn: 'remote-server.ts.net',
        hardwareTier: 'High-end',
        acceptingTrainingJobs: true,
        availableVramMb: 32768,
        gpuPressure: 0,
        supportedFrameworks: ['pytorch'],
        activeTrainingJobs: 0,
        lastUpdated: new Date().toISOString(),
      });

      pool.dispatchJobToPeer.mockResolvedValue({
        jobId: 'job-offload',
        appId: 'ci-memory',
        jobType: 'hbpe_bootstrap_hmt',
        state: 'RUNNING',
        executedOnNode: 'remote-server.ts.net',
        currentEpoch: 0,
        totalEpochs: 10,
        trainLoss: 0,
        valLoss: null,
        progressPercent: 0,
        etaSeconds: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = await controller.submitTrainingJob(manifest);
      expect(result.executedOnNode).toBe('remote-server.ts.net');
      expect(pool.dispatchJobToPeer).toHaveBeenCalledWith('remote-server.ts.net', manifest);
    });
  });
});
