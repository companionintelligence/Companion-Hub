import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { HubPoolPeerService } from '@/modules/hub-pool/hub-pool-peer.service';
import { InferenceBackendRegistry } from '../backends/backend-registry';
import type { DsparkBackend } from '../backends/dspark.backend';
import type { LemonadeBackend } from '../backends/lemonade.backend';
import type { LuceboxBackend } from '../backends/lucebox.backend';
import type { LlamacppBackend } from '../backends/llamacpp.backend';
import type { LmStudioBackend } from '../backends/lmstudio.backend';
import type { MtplxBackend } from '../backends/mtplx.backend';
import type { OllamaBackend } from '../backends/ollama.backend';
import type { VllmBackend } from '../backends/vllm.backend';
import { InferenceEndpointService, isPoolProxyUrl } from '../inference-endpoint.service';
import { ConfigurationService } from '@/core/config/configuration.service';

const DIRECTIONS_ON = { outbound: { enabled: true, disabledBy: null }, inbound: { enabled: true, disabledBy: null } };
const DOWN = { running: false, healthy: false, modelsLoaded: [] as string[] };

const peer = (name: string, overrides: Partial<HubPoolPeer> = {}, capabilities: Record<string, unknown> = {}): HubPoolPeer =>
  ({
    id: `id-${name}`,
    nodeFqdn: `${name}.tailnet.ts.net`,
    displayName: name,
    status: 'connected',
    enabled: true,
    lastCapabilities: { hardwareTier: 'high', backends: [{ type: 'ollama', healthy: true, modelsLoaded: [`${name}-model:8b`] }], ...capabilities },
    ...overrides,
  }) as unknown as HubPoolPeer;

describe('InferenceEndpointService — pool inventory and membership', () => {
  let service: InferenceEndpointService;
  let peers: MockProxy<HubPoolPeerService>;
  let ollama: MockProxy<OllamaBackend>;
  let vllm: MockProxy<VllmBackend>;
  let logger: MockProxy<LoggerService>;
  let config: MockProxy<ConfigurationService>;

  beforeEach(() => {
    logger = mock<LoggerService>();
    config = mock<ConfigurationService>();
    peers = mock<HubPoolPeerService>();
    ollama = mock<OllamaBackend>();
    vllm = mock<VllmBackend>();
    const others = [
      mock<LemonadeBackend>(),
      mock<MtplxBackend>(),
      mock<DsparkBackend>(),
      mock<LuceboxBackend>(),
      mock<LlamacppBackend>(),
      mock<LmStudioBackend>(),
    ];
    for (const backend of others) backend.healthCheck.mockResolvedValue(DOWN);
    ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['gemma3:1b'] });
    vllm.healthCheck.mockResolvedValue(DOWN);
    const registry = new InferenceBackendRegistry(
      ollama,
      vllm,
      others[0] as LemonadeBackend,
      others[1] as MtplxBackend,
      others[2] as DsparkBackend,
      others[3] as LuceboxBackend,
      others[4] as LlamacppBackend,
      others[5] as LmStudioBackend,
    );
    service = new InferenceEndpointService(logger, registry, ollama, peers, config);

    // `poolRouteAppsAlways` defaults on; the one case that needs it off turns it off itself.
    config.getHubPoolPreferences.mockReturnValue({ poolRouteAppsAlways: true } as never);

    peers.hasConnectedPeers.mockResolvedValue(true);
    peers.directions.mockReturnValue(DIRECTIONS_ON);
    peers.listConnectedPeers.mockResolvedValue([peer('core-6')]);
  });

  describe('poolInventory', () => {
    it('lists this node healthy backends and every usable peer backend, by node name', async () => {
      const inventory = await service.poolInventory('test');

      expect(inventory.backends).toEqual([
        { node: 'this Hub', local: true, backend: 'ollama', models: ['gemma3:1b'] },
        { node: 'core-6', local: false, backend: 'ollama', models: ['core-6-model:8b'] },
      ]);
    });

    it('leaves out a local model the engine is withholding as unservable, as the proxy does', async () => {
      // A fleet node answered /api/tags with gemma3:1b while every generate for it returned 500.
      ollama.healthCheck.mockResolvedValue({
        running: true,
        healthy: true,
        modelsLoaded: ['gemma3:1b', 'qwen3:8b'],
        unservableModels: ['gemma3:1b'],
      });

      const inventory = await service.poolInventory('test');

      expect(inventory.backends[0]?.models).toEqual(['qwen3:8b']);
    });

    it('drops every peer the proxy would not route to', async () => {
      peers.listConnectedPeers.mockResolvedValue([
        peer('disabled', { enabled: false }),
        peer('refusing', {}, { acceptingWork: false }),
        peer('engine-down', {}, { backends: [{ type: 'ollama', healthy: false, modelsLoaded: ['x:1b'] }] }),
        peer('never-probed', { lastCapabilities: null }),
        peer('usable'),
      ]);

      const inventory = await service.poolInventory('test');

      expect(inventory.backends.map((entry) => entry.node)).toEqual(['this Hub', 'usable']);
    });

    it('lists no peers while outbound pooling is off, though apps stay routed through the proxy', async () => {
      peers.directions.mockReturnValue({ ...DIRECTIONS_ON, outbound: { enabled: false, disabledBy: 'setting' } });

      const inventory = await service.poolInventory('test');

      expect(inventory.backends.map((entry) => entry.node)).toEqual(['this Hub']);
    });

    it('carries each node context cap, so a pooled handout can take the minimum over the nodes serving the model', async () => {
      config.getInferencePreferences.mockReturnValue({ maxNumCtx: 32_768 } as never);
      peers.listConnectedPeers.mockResolvedValue([peer('core-2', {}, { maxNumCtx: 16_384 }), peer('core-6')]);

      const inventory = await service.poolInventory('test');

      expect(inventory.backends).toEqual([
        { node: 'this Hub', local: true, backend: 'ollama', models: ['gemma3:1b'], maxNumCtx: 32_768 },
        { node: 'core-2', local: false, backend: 'ollama', models: ['core-2-model:8b'], maxNumCtx: 16_384 },
        // Absent on the wire (an older build, or no cap) stays absent here: it is not a cap of 0.
        { node: 'core-6', local: false, backend: 'ollama', models: ['core-6-model:8b'] },
      ]);
    });

    it('reads a peer cap the way the wire is read: a value this build cannot believe is no cap', async () => {
      peers.listConnectedPeers.mockResolvedValue([peer('core-2', {}, { maxNumCtx: '16384' }), peer('core-6', {}, { maxNumCtx: 12 })]);

      const inventory = await service.poolInventory('test');

      expect(inventory.backends.filter((entry) => !entry.local).every((entry) => !('maxNumCtx' in entry))).toBe(true);
    });

    it('degrades to this node alone, with a warning, when the peer table cannot be read', async () => {
      peers.listConnectedPeers.mockRejectedValue(new Error('connection refused'));

      const inventory = await service.poolInventory('test');

      expect(inventory.backends.map((entry) => entry.node)).toEqual(['this Hub']);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
    });
  });

  describe('localContextCap', () => {
    it('is the persisted cap, clamped, and null when none is set or the configuration cannot answer', () => {
      config.getInferencePreferences.mockReturnValue({ maxNumCtx: 16_384 } as never);
      expect(service.localContextCap()).toBe(16_384);

      config.getInferencePreferences.mockReturnValue({ maxNumCtx: null } as never);
      expect(service.localContextCap()).toBeNull();

      config.getInferencePreferences.mockImplementation(() => {
        throw new Error('settings mid-migration');
      });
      expect(service.localContextCap()).toBeNull();
    });
  });

  describe('resolvePoolRouting', () => {
    it('is null with no connected peer once the always-on switch is off, so a single-node Hub keeps choosing from its own backend', async () => {
      config.getHubPoolPreferences.mockReturnValue({ poolRouteAppsAlways: false } as never);
      peers.hasConnectedPeers.mockResolvedValue(false);

      expect(await service.resolvePoolRouting('test')).toBeNull();
      expect(ollama.healthCheck).not.toHaveBeenCalled();
    });

    it('routes a peerless Hub through the proxy for transport only when the always-on switch is on', async () => {
      // `poolRouteAppsAlways` is the default. Routing is on, but `spansPeers` is false, so the two
      // handout paths keep choosing the model the direct path would have chosen.
      peers.hasConnectedPeers.mockResolvedValue(false);

      const routing = await service.resolvePoolRouting('test');

      expect(isPoolProxyUrl(routing?.baseUrl)).toBe(true);
      expect(routing?.reason).toBe('always');
      expect(routing?.spansPeers).toBe(false);
    });

    it('carries the proxy URL apps are rewritten to', async () => {
      const routing = await service.resolvePoolRouting('test');

      expect(isPoolProxyUrl(routing?.baseUrl)).toBe(true);
      expect(service.applyPoolRouting({ openAiBaseUrl: 'http://ollama:11434/v1' }, routing, 'test').openAiBaseUrl).toBe(`${routing?.baseUrl}/v1`);
    });
  });

  describe('poolMembership', () => {
    it('changes when a peer pairs or leaves, and not when its inventory changes', async () => {
      const one = await service.poolMembership('test');
      peers.listConnectedPeers.mockResolvedValue([peer('core-6', {}, { backends: [{ type: 'ollama', healthy: true, modelsLoaded: ['other:1b'] }] })]);
      const sameMembersNewModels = await service.poolMembership('test');
      peers.listConnectedPeers.mockResolvedValue([peer('core-6'), peer('core-7')]);
      const two = await service.poolMembership('test');
      peers.hasConnectedPeers.mockResolvedValue(false);
      const none = await service.poolMembership('test');

      expect(sameMembersNewModels.signature).toBe(one.signature);
      expect(two.signature).not.toBe(one.signature);
      expect(two.description).toBe('routing through the pool with core-6, core-7');
      expect(none.signature).toBe('direct');
    });

    it('changes again when a just-approved peer delivers its first capability snapshot, or stops accepting work', async () => {
      // Approval marks the row connected a full health poll before any capabilities arrive, so a
      // refresh at approval time saw none of the new peer's models.
      peers.listConnectedPeers.mockResolvedValue([peer('core-6', { lastCapabilities: null })]);
      const approved = await service.poolMembership('test');
      peers.listConnectedPeers.mockResolvedValue([peer('core-6')]);
      const probed = await service.poolMembership('test');
      peers.listConnectedPeers.mockResolvedValue([peer('core-6', {}, { acceptingWork: false })]);
      const refusing = await service.poolMembership('test');

      expect(new Set([approved.signature, probed.signature, refusing.signature]).size).toBe(3);
    });

    it('reports an unreadable peer table as unknown, not as every peer disconnecting', async () => {
      peers.hasConnectedPeers.mockRejectedValue(new Error('pool table locked'));

      const membership = await service.poolMembership('test');

      expect(membership.signature).toBeNull();
    });
  });
});
