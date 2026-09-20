import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import {
  DEFAULT_POOL_HEALTH_POLL_SECONDS,
  DEFAULT_POOL_LOCAL_AFFINITY,
  DEFAULT_POOL_PRESSURE_WEIGHT,
  MAX_POOL_PINS,
  removePoolPin,
  resolvePinFor,
  upsertPoolPin,
  type HubPoolPin,
  type HubPoolPreferences,
} from '@/common/helpers/hub-pool';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { HubPoolPeerRepository } from '../hub-pool-peer.repository';
import { HubPoolPinService } from '../hub-pool-pin.service';
import { applyPin, describeNoCandidates, describePinForLog } from '../hub-pool-proxy.service';
import { resolveStatusPins } from '../hub-pool.types';
import type { PoolCandidate, PoolPeerCapabilities } from '../hub-pool.types';

const localCandidate = (backend: 'ollama' | 'vllm' = 'ollama'): PoolCandidate => ({ peerId: null, nodeFqdn: null, backend });
const peerCandidate = (id: string): PoolCandidate => ({ peerId: id, nodeFqdn: `${id}.tailxyz.ts.net`, backend: 'ollama' });

const pin = (overrides: Partial<HubPoolPin> = {}): HubPoolPin => ({ scope: 'default', targetKind: 'local', mode: 'prefer', ...overrides });

function mockPeer(overrides: Partial<HubPoolPeer> = {}): HubPoolPeer {
  return {
    id: 'peer-1',
    tailscaleDeviceId: null,
    nodeFqdn: 'peer-hub.tailxyz.ts.net',
    displayName: null,
    direction: 'outbound',
    status: 'connected',
    enabled: true,
    consecutiveFailures: 0,
    lastSeenAt: new Date().toISOString(),
    lastCapabilities: {
      hardwareTier: 'high',
      backends: [{ type: 'ollama', healthy: true, modelsLoaded: ['llama3.2:3b'] }],
      updatedAt: new Date().toISOString(),
    } as unknown as PoolPeerCapabilities as unknown as Record<string, unknown>,
    verifyTokenHash: 'hash',
    presentTokenEncrypted: null,
    peerNodeUuid: null,
    peerPublicKey: null,
    bearerGraceUntil: null,
    signedSeenAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * `applyPin` is the whole behavioural change pinning makes, so it is tested as the pure function it
 * is rather than only through the proxy.
 */
describe('applyPin', () => {
  const ordered = [localCandidate(), peerCandidate('peer-a'), peerCandidate('peer-b')];

  it('returns the ranked list unchanged, by identity, when there is no pin', () => {
    expect(applyPin(ordered, null)).toBe(ordered);
  });

  it('moves the pinned peer to the front and keeps the rest in ranked order', () => {
    expect(applyPin(ordered, pin({ targetKind: 'peer', peerId: 'peer-b' })).map((candidate) => candidate.peerId)).toEqual(['peer-b', null, 'peer-a']);
  });

  it('moves EVERY local backend to the front for a local pin, so intra-node failover survives', () => {
    const list = [peerCandidate('peer-a'), localCandidate('ollama'), localCandidate('vllm')];
    expect(applyPin(list, pin()).map((candidate) => candidate.backend)).toEqual(['ollama', 'vllm', 'ollama']);
  });

  /** The property the whole design rests on: a pin filters a finished list, so it cannot add to it. */
  it('never resurrects a node that is not already a candidate', () => {
    const withoutTheTarget = [localCandidate()];
    expect(applyPin(withoutTheTarget, pin({ targetKind: 'peer', peerId: 'peer-gone' }))).toBe(withoutTheTarget);
  });

  it('cannot empty a candidate list', () => {
    for (const target of [pin(), pin({ targetKind: 'peer', peerId: 'peer-a' }), pin({ targetKind: 'peer', peerId: 'nobody' })]) {
      expect(applyPin(ordered, target)).toHaveLength(ordered.length);
    }
  });
});

describe('resolvePinFor', () => {
  const defaultPin = pin();
  const modelPin = pin({ scope: 'model', model: 'llama3.2:3b', targetKind: 'peer', peerId: 'peer-a' });

  it('has no opinion when nothing is pinned', () => {
    expect(resolvePinFor([], 'llama3.2:3b')).toBeNull();
    expect(resolvePinFor(undefined, 'llama3.2:3b')).toBeNull();
  });

  it('prefers the model pin over the default pin, and they never stack', () => {
    expect(resolvePinFor([defaultPin, modelPin], 'llama3.2:3b')).toBe(modelPin);
  });

  it('falls back to the default pin for a model no pin names', () => {
    expect(resolvePinFor([defaultPin, modelPin], 'other:1b')).toBe(defaultPin);
  });

  it('compares the model verbatim, because candidate matching does', () => {
    expect(resolvePinFor([modelPin], 'Llama3.2:3B')).toBeNull();
  });
});

describe('upsertPoolPin / removePoolPin', () => {
  const defaultPin = pin();
  const modelPin = pin({ scope: 'model', model: 'a:1b' });

  it('replaces the pin for the same (scope, model) in place rather than appending', () => {
    const replaced = pin({ scope: 'model', model: 'a:1b', targetKind: 'peer', peerId: 'peer-a' });
    expect(upsertPoolPin([defaultPin, modelPin], replaced)).toEqual([defaultPin, replaced]);
  });

  it('appends a pin for a model that has none', () => {
    expect(upsertPoolPin([defaultPin], modelPin)).toEqual([defaultPin, modelPin]);
  });

  it('removes only the addressed pin', () => {
    expect(removePoolPin([defaultPin, modelPin], 'model', 'a:1b')).toEqual([defaultPin]);
    expect(removePoolPin([defaultPin, modelPin], 'default')).toEqual([modelPin]);
    expect(removePoolPin([defaultPin, modelPin], 'model', 'not-pinned')).toEqual([defaultPin, modelPin]);
  });
});

describe('describePinForLog', () => {
  it('carries the shape of the pin and neither the model nor the peer id', () => {
    expect(describePinForLog(pin({ scope: 'model', model: 'secret-model', targetKind: 'peer', peerId: 'peer-a' }))).toEqual({
      scope: 'model',
      mode: 'prefer',
      targetKind: 'peer',
    });
    expect(describePinForLog(null)).toBeNull();
  });
});

describe('describeNoCandidates', () => {
  it('is the plain message when nothing is pinned', () => {
    expect(describeNoCandidates('a:1b', null)).toBe('No pool node currently has model "a:1b" available.');
  });

  it('names the pin, and still says the empty list is an inventory problem', () => {
    const message = describeNoCandidates('a:1b', pin({ targetKind: 'peer', peerId: 'peer-a' }));
    expect(message).toContain('Routing is pinned to a peer');
    expect(message).toContain('the pin only reorders candidates');
    // Never the peer's name: this runs on an error path and must not need a database read.
    expect(message).not.toContain('peer-a');
  });
  it('names a local backend that answered but was left out, with its reason', () => {
    const message = describeNoCandidates('Qwen/Qwen3.5-9B', null, [
      { type: 'ollama', url: 'http://host.docker.internal:11434', running: true, healthy: true, listsModel: false },
      {
        type: 'mtplx',
        url: 'http://host.docker.internal:8000',
        running: true,
        healthy: false,
        listsModel: false,
        error: 'The server at http://host.docker.internal:8000 names itself "vllm"',
      },
    ]);
    expect(message).toBe(
      'No pool node currently has model "Qwen/Qwen3.5-9B" available. ' +
        'local mtplx at http://host.docker.internal:8000 answered but was left out: The server at http://host.docker.internal:8000 names itself "vllm".',
    );
  });

  it('points at the unreachable local backends instead of listing six connection errors', () => {
    // beta-nas, 2026-09-20: vLLM served the model on the host and ufw dropped the container's
    // probe. "No pool node has it" sent the operator to the peers; the truth was one firewall rule.
    const message = describeNoCandidates('Qwen/Qwen2.5-3B-Instruct-AWQ', null, [
      { type: 'ollama', url: 'http://host.docker.internal:11434', running: true, healthy: true, listsModel: false },
      {
        type: 'vllm',
        url: 'http://host.docker.internal:8000',
        running: false,
        healthy: false,
        listsModel: false,
        error: 'timeout of 5000ms exceeded',
      },
      {
        type: 'lemonade',
        url: 'http://host.docker.internal:13305',
        running: false,
        healthy: false,
        listsModel: false,
        error: 'timeout of 5000ms exceeded',
      },
    ]);
    expect(message).toContain('local vllm, lemonade not reachable from inside the Hub container');
    expect(message).toContain('`localBackends`');
    expect(message).not.toContain('timeout of 5000ms');
  });

  it('keeps the pin sentence and appends the local view after it', () => {
    const message = describeNoCandidates('a:1b', pin({ targetKind: 'local' }), [
      { type: 'ollama', url: 'http://host.docker.internal:11434', running: false, healthy: false, listsModel: false, error: 'ECONNREFUSED' },
    ]);
    expect(message).toMatch(/^No pool node currently has model "a:1b" available\. Routing is pinned to this Hub, which cannot serve it either/);
    expect(message).toMatch(/local ollama not reachable from inside the Hub container/);
  });

  it('says nothing about local backends when there are no probes (the pre-existing message)', () => {
    expect(describeNoCandidates('a:1b', null, [])).toBe('No pool node currently has model "a:1b" available.');
  });
});

describe('resolveStatusPins', () => {
  const localBackends = [{ type: 'ollama' as const, healthy: true, modelsLoaded: ['llama3.2:3b'] }];

  it('reports a local pin as available when a healthy backend holds the model', () => {
    expect(resolveStatusPins([pin({ scope: 'model', model: 'llama3.2:3b' })], [], localBackends)).toEqual([
      { scope: 'model', model: 'llama3.2:3b', targetKind: 'local', mode: 'prefer', nodeFqdn: null, targetAvailable: true },
    ]);
  });

  it('reports a local pin for a model this node does not have as unavailable', () => {
    expect(resolveStatusPins([pin({ scope: 'model', model: 'gone:1b' })], [], localBackends)[0]?.targetAvailable).toBe(false);
  });

  it('resolves a peer pin to its FQDN', () => {
    const [resolved] = resolveStatusPins([pin({ targetKind: 'peer', peerId: 'peer-1' })], [mockPeer()], localBackends);
    expect(resolved?.nodeFqdn).toBe('peer-hub.tailxyz.ts.net');
    expect(resolved?.targetAvailable).toBe(true);
  });

  /** Every way a pin silently stops applying, which is exactly what the status card exists to say. */
  it.each([
    ['unreachable', mockPeer({ status: 'unreachable' })],
    ['disabled here', mockPeer({ enabled: false })],
    ['still pending approval', mockPeer({ status: 'pending' })],
    [
      'not accepting our work',
      mockPeer({
        lastCapabilities: { hardwareTier: 'high', backends: [], acceptingWork: false, updatedAt: '' } as unknown as Record<string, unknown>,
      }),
    ],
    ['never probed', mockPeer({ lastCapabilities: null })],
  ])('reports a peer pin as unavailable when the peer is %s', (_label, peer) => {
    expect(resolveStatusPins([pin({ targetKind: 'peer', peerId: 'peer-1' })], [peer], localBackends)[0]?.targetAvailable).toBe(false);
  });

  it('reports a pin whose peer was unpaired as unavailable and unnamed, rather than dropping it', () => {
    const [resolved] = resolveStatusPins([pin({ targetKind: 'peer', peerId: 'peer-deleted' })], [mockPeer()], localBackends);
    expect(resolved).toMatchObject({ nodeFqdn: null, targetAvailable: false });
  });
});

describe('HubPoolPinService', () => {
  let configuration: MockProxy<ConfigurationService>;
  let peers: MockProxy<HubPoolPeerRepository>;
  let service: HubPoolPinService;
  let stored: HubPoolPin[];

  function preferences(): HubPoolPreferences {
    return {
      poolEnabled: true,
      poolOutboundEnabled: true,
      poolInboundEnabled: true,
      poolLocalAffinity: DEFAULT_POOL_LOCAL_AFFINITY,
      poolHealthPollSeconds: DEFAULT_POOL_HEALTH_POLL_SECONDS,
      poolRequireSignedPeers: false,
      poolPressureWeight: DEFAULT_POOL_PRESSURE_WEIGHT,
      poolPins: stored,
    };
  }

  beforeEach(() => {
    stored = [];
    configuration = mock<ConfigurationService>();
    peers = mock<HubPoolPeerRepository>();
    configuration.getHubPoolPreferences.mockImplementation(preferences);
    configuration.setHubPoolPreferences.mockImplementation(async (update) => {
      if (update.poolPins) stored = update.poolPins;
      return preferences();
    });
    service = new HubPoolPinService(configuration, peers);
  });

  it('applies the only mode there is when the caller omits it, since the DTO cannot default it', async () => {
    // `.default()` in the zod schema would be promoted into `required` in the generated client, so
    // the default has to live here.
    await service.upsert({ scope: 'default', targetKind: 'local' });

    expect(stored).toEqual([{ scope: 'default', targetKind: 'local', mode: 'prefer' }]);
  });

  it('stores a model pin with the model and nothing else', async () => {
    peers.findById.mockResolvedValue(mockPeer());

    expect(await service.upsert({ scope: 'model', model: 'llama3.2:3b', targetKind: 'peer', targetPeerId: 'peer-1' })).toEqual([
      { scope: 'model', model: 'llama3.2:3b', targetKind: 'peer', peerId: 'peer-1', mode: 'prefer' },
    ]);
  });

  it('404s a pin at a peer id that names no row, rather than storing one that can never apply', async () => {
    peers.findById.mockResolvedValue(undefined);

    await expect(service.upsert({ scope: 'default', targetKind: 'peer', targetPeerId: 'nobody' })).rejects.toBeInstanceOf(NotFoundException);
    expect(configuration.setHubPoolPreferences).not.toHaveBeenCalled();
  });

  /** `unreachable` is the state the module recovers from on its own; refusing to pin one would be the worse trap. */
  it('allows pinning a peer that is currently unreachable', async () => {
    peers.findById.mockResolvedValue(mockPeer({ status: 'unreachable', consecutiveFailures: 3 }));

    await expect(service.upsert({ scope: 'default', targetKind: 'peer', targetPeerId: 'peer-1' })).resolves.toHaveLength(1);
  });

  it('refuses to grow the list past the cap, but still replaces an existing pin at the cap', async () => {
    stored = Array.from({ length: MAX_POOL_PINS }, (_unused, index) => pin({ scope: 'model', model: `model-${index}` }));

    await expect(service.upsert({ scope: 'model', model: 'one-too-many', targetKind: 'local' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.upsert({ scope: 'model', model: 'model-0', targetKind: 'local' })).resolves.toHaveLength(MAX_POOL_PINS);
  });

  it('does not rewrite settings.json when removing a pin that is not there', async () => {
    // Every settings write is an unlocked read-modify-write of the whole file, so a no-op DELETE
    // that still wrote could clobber a concurrent save from another surface.
    await service.remove('model', 'never-pinned');

    expect(configuration.setHubPoolPreferences).not.toHaveBeenCalled();
  });

  it('400s a remove whose scope and model disagree, which the query DTO cannot refine', async () => {
    await expect(service.remove('model')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.remove('default', 'a:1b')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('removes the pin it was asked for', async () => {
    stored = [pin(), pin({ scope: 'model', model: 'a:1b' })];

    expect(await service.remove('default')).toEqual([pin({ scope: 'model', model: 'a:1b' })]);
  });
});
