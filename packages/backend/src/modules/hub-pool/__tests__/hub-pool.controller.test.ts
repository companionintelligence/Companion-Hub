import { ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { Request } from 'express';
import { ConfigurationService } from '@/core/config/configuration.service';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { HubPoolPeerService } from '../hub-pool-peer.service';
import { HubPoolRoutingLogService } from '../hub-pool-routing-log.service';
import { PoolProxyService } from '../hub-pool-proxy.service';
import { HubPoolController } from '../hub-pool.controller';
import type { PoolStatus } from '../hub-pool.types';

function poolStatus(overrides: Partial<PoolStatus> = {}): PoolStatus {
  return {
    enabled: true,
    disabledBy: null,
    reason: 'no_peers',
    routingActive: false,
    settings: { poolEnabled: true, poolLocalAffinity: 1, poolHealthPollSeconds: 30 },
    tailscaleAdminApiConfigured: false,
    localNode: {
      nodeFqdn: 'self-hub.example-tailnet.ts.net',
      tailnet: 'example-tailnet.ts.net',
      tailscaleConnected: true,
      inFlightRequests: 0,
      hardwareTier: 'high',
      backends: [],
      capabilitiesError: null,
    },
    peers: [],
    peerCounts: { total: 0, connected: 0, pending: 0, unreachable: 0 },
    ...overrides,
  };
}

describe('HubPoolController', () => {
  let peerService: MockProxy<HubPoolPeerService>;
  let configuration: MockProxy<ConfigurationService>;
  let routingLog: HubPoolRoutingLogService;
  let controller: HubPoolController;

  beforeEach(() => {
    peerService = mock<HubPoolPeerService>();
    configuration = mock<ConfigurationService>();
    routingLog = new HubPoolRoutingLogService();
    controller = new HubPoolController(peerService, mock<PoolProxyService>(), mock<TailscaleService>(), configuration, routingLog);
  });

  describe('GET status', () => {
    it('answers the whole operator question in one payload, routing summary included', async () => {
      peerService.getPoolStatus.mockResolvedValue(poolStatus({ reason: 'active', routingActive: true }));
      routingLog.record({
        at: new Date().toISOString(),
        direction: 'outbound',
        path: '/v1/chat/completions',
        model: 'llama3.2:3b',
        node: 'local',
        peerId: null,
        backend: 'ollama',
        candidates: 2,
        attempt: 1,
        failedOverFrom: [],
        outcome: 'served',
        status: 200,
        durationMs: 8,
      });

      const status = await controller.poolStatus();

      expect(status).toMatchObject({ reason: 'active', routingActive: true });
      expect(status.routing).toMatchObject({ recorded: 1, served: 1, failed: 0, failovers: 0 });
    });
  });

  describe('settings', () => {
    it('reads the persisted preferences without touching the peer table', async () => {
      configuration.getHubPoolPreferences.mockReturnValue({ poolEnabled: false, poolLocalAffinity: 3, poolHealthPollSeconds: 45 });

      await expect(controller.getPoolSettings()).resolves.toEqual({ poolEnabled: false, poolLocalAffinity: 3, poolHealthPollSeconds: 45 });
    });

    it('passes a partial PATCH straight through, so an omitted field stays unchanged', async () => {
      configuration.setHubPoolPreferences.mockResolvedValue({ poolEnabled: true, poolLocalAffinity: 0, poolHealthPollSeconds: 30 });

      await controller.updatePoolSettings({ poolLocalAffinity: 0 });

      expect(configuration.setHubPoolPreferences).toHaveBeenCalledWith({ poolLocalAffinity: 0 });
    });
  });

  describe('GET routing-log', () => {
    it('honours the limit and returns newest first alongside the summary', async () => {
      for (const model of ['a', 'b', 'c']) {
        routingLog.record({
          at: new Date().toISOString(),
          direction: 'outbound',
          path: '/v1/chat/completions',
          model,
          node: 'local',
          peerId: null,
          backend: 'ollama',
          candidates: 1,
          attempt: 1,
          failedOverFrom: [],
          outcome: 'served',
          status: 200,
          durationMs: 1,
        });
      }

      const result = await controller.getPoolRoutingLog({ limit: 2 });

      expect(result.entries.map((e) => e.model)).toEqual(['c', 'b']);
      expect(result.summary.recorded).toBe(3);
    });
  });

  describe('GET capabilities', () => {
    it('refuses a peer probe outright when pooling is off, rather than answering "I have nothing"', async () => {
      // Answering emptily would be cached by the peer as this node's capabilities; a hard failure
      // is what correctly marks us unreachable to it.
      peerService.enabledState.mockReturnValue({ enabled: false, disabledBy: 'setting' });

      await expect(controller.capabilities({ poolPeer: { status: 'connected' } } as unknown as Request)).rejects.toThrow(ServiceUnavailableException);
      expect(peerService.getOwnCapabilities).not.toHaveBeenCalled();
    });
  });
});
