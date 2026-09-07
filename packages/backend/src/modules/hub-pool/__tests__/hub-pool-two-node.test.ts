import { createHash, randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { Request } from 'express';
import { LoggerService } from '@/core/logger/logger.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { TailscaleAdminApiService } from '@/modules/tailscale/tailscale-admin-api.service';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';
import type { HubPoolPeer, NewHubPoolPeer } from '@/core/database/drizzle/types';
import {
  DEFAULT_POOL_HEALTH_POLL_SECONDS,
  DEFAULT_POOL_LOCAL_AFFINITY,
  DEFAULT_POOL_PRESSURE_WEIGHT,
  type HubPoolPreferences,
} from '@/common/helpers/hub-pool';
import { HubPoolPressureService } from '../hub-pool-pressure.service';
import { HubPoolPeerRepository } from '../hub-pool-peer.repository';
import { HubPoolPeerService } from '../hub-pool-peer.service';
import { HubPoolLoadService } from '../hub-pool-load.service';
import { HubPoolRoutingLogService } from '../hub-pool-routing-log.service';
import { PoolProxyService } from '../hub-pool-proxy.service';
import { HubPoolController } from '../hub-pool.controller';
import { PoolPeerGuard } from '../guards/pool-peer.guard';
import type { PoolPeerCapabilities } from '../hub-pool.types';

/**
 * The pairing handshake is the one part of Hub Pool whose correctness lives *between* two machines:
 * each side stores half of a two-token exchange, and every later call depends on the other side
 * having stored its half correctly. A single-node test can only assert that a row was written — it
 * cannot catch the tokens being swapped, a name being stored uncanonicalized, or a callback landing
 * on the wrong row, all of which look fine locally and fail in the lab.
 *
 * So this file runs two full nodes in one process: real `HubPoolPeerService`, real `PoolPeerGuard`,
 * real `HubPoolController` and an in-memory repository each, with `global.fetch` routed between them
 * by FQDN. Only the two ends of the wire are faked. It is the automated half of
 * `docs/hub-pool-fleet-testing.md` sections 2, 6 and 7.
 */

const CORE_FQDN = 'hub-a.example-tailnet.ts.net';
const BETA_FQDN = 'hub-b.example-tailnet.ts.net';
const TAILNET = 'example-tailnet.ts.net';
const SHARED_MODEL = 'llama3.2:3b';
const BETA_ONLY_MODEL = 'qwen3:0.6b';

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * In-memory `hub_pool_peer` table. Enforces the schema's unique `node_fqdn`, because "re-pair after
 * an unpair" is only a real test if a leftover row would still collide.
 */
class FakePeerRepository {
  readonly rows = new Map<string, HubPoolPeer>();

  async create(data: NewHubPoolPeer): Promise<HubPoolPeer> {
    if ([...this.rows.values()].some((row) => row.nodeFqdn === data.nodeFqdn)) {
      throw new Error(`duplicate key value violates unique constraint "hub_pool_peer_node_fqdn_unique"`);
    }
    const now = new Date().toISOString();
    const row: HubPoolPeer = {
      id: randomUUID(),
      tailscaleDeviceId: null,
      displayName: null,
      // Mirrors the column's NOT NULL DEFAULT true: a freshly paired peer is in routing.
      enabled: true,
      consecutiveFailures: 0,
      lastSeenAt: null,
      lastCapabilities: null,
      verifyTokenHash: null,
      presentTokenEncrypted: null,
      peerNodeUuid: null,
      peerPublicKey: null,
      bearerGraceUntil: null,
      signedSeenAt: null,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      ...(data as Partial<HubPoolPeer>),
    } as HubPoolPeer;
    this.rows.set(row.id, row);
    return row;
  }

  async findById(id: string): Promise<HubPoolPeer | undefined> {
    return this.rows.get(id);
  }

  async findByNodeFqdn(nodeFqdn: string): Promise<HubPoolPeer | undefined> {
    return [...this.rows.values()].find((row) => row.nodeFqdn === nodeFqdn);
  }

  async listAll(): Promise<HubPoolPeer[]> {
    return [...this.rows.values()];
  }

  async listByStatus(status: string): Promise<HubPoolPeer[]> {
    return [...this.rows.values()].filter((row) => row.status === status);
  }

  async listByStatuses(statuses: string[]): Promise<HubPoolPeer[]> {
    return [...this.rows.values()].filter((row) => statuses.includes(row.status));
  }

  async update(id: string, data: Partial<NewHubPoolPeer>): Promise<HubPoolPeer | undefined> {
    const existing = this.rows.get(id);
    if (!existing) return undefined;
    const next = { ...existing, ...(data as Partial<HubPoolPeer>), updatedAt: new Date().toISOString() };
    this.rows.set(id, next);
    return next;
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }

  /** The single row this node holds, when the test has arranged for exactly one. */
  only(): HubPoolPeer {
    const rows = [...this.rows.values()];
    if (rows.length !== 1) {
      throw new Error(`expected exactly one peer row, found ${rows.length}`);
    }
    return rows[0] as HubPoolPeer;
  }
}

interface Node {
  fqdn: string;
  repo: FakePeerRepository;
  service: HubPoolPeerService;
  controller: HubPoolController;
  guard: PoolPeerGuard;
  configuration: MockProxy<ConfigurationService>;
  setPoolEnabled(enabled: boolean): void;
  setInboundEnabled(enabled: boolean): void;
  setOutboundEnabled(enabled: boolean): void;
  /** Take one peer of this node out of the pool, as the operator switch does. */
  setPeerEnabled(id: string, enabled: boolean): Promise<void>;
  /** Runs one health-poll tick, as the module's own timer would. */
  poll(): Promise<void>;
}

function buildNode(fqdn: string, models: string[]): Node {
  const repo = new FakePeerRepository();
  const configuration = mock<ConfigurationService>();
  const preferences: HubPoolPreferences = {
    poolEnabled: true,
    poolOutboundEnabled: true,
    poolInboundEnabled: true,
    poolLocalAffinity: DEFAULT_POOL_LOCAL_AFFINITY,
    poolHealthPollSeconds: DEFAULT_POOL_HEALTH_POLL_SECONDS,
    poolPressureWeight: DEFAULT_POOL_PRESSURE_WEIGHT,
  };
  configuration.getHubPoolPreferences.mockImplementation(() => ({ ...preferences }));

  const encryption = mock<EncryptionService>();
  // Salted with the row's nodeFqdn in production; carrying the salt here keeps a token decrypted
  // against the wrong row visibly wrong rather than silently identical.
  encryption.encrypt.mockImplementation((data: string, salt: string) => `ENC(${salt}):${data}`);
  encryption.decrypt.mockImplementation((data: string, salt: string) => {
    const prefix = `ENC(${salt}):`;
    if (!data.startsWith(prefix)) throw new Error(`token was encrypted for a different peer than ${salt}`);
    return data.slice(prefix.length);
  });

  const tailscaleService = mock<TailscaleService>();
  tailscaleService.getStatusCached.mockResolvedValue({
    installed: true,
    connected: true,
    version: '1.90.0',
    hostname: fqdn.split('.')[0] as string,
    nodeFqdn: fqdn,
    tailnet: TAILNET,
    ip: '100.64.0.1',
    supportsServices: true,
    httpsAvailable: true,
    backendState: 'Running',
    authUrl: null,
  });

  const tailscaleAdminApi = mock<TailscaleAdminApiService>();
  tailscaleAdminApi.isConfigured.mockReturnValue(false);

  const inferenceRouter = mock<InferenceRouterService>();
  inferenceRouter.getStatus.mockResolvedValue({
    hardwareTier: 'high',
    backends: [{ type: 'ollama', running: true, healthy: true, url: 'http://ollama:11434', modelsLoaded: models.length }],
    models: [],
    memoryBudget: {
      totalVramMb: 24576,
      totalRamMb: 65536,
      systemReservedRamMb: 8192,
      dockerOverheadMb: 2048,
      appContainerBudgetMb: 8192,
      modelBudgetVramMb: 20480,
      modelBudgetRamMb: 32768,
      modelUsedVramMb: 0,
      modelUsedRamMb: 0,
      pinnedVramMb: 0,
      pinnedRamMb: 0,
    },
    cloudProviders: [],
  });
  inferenceRouter.listModels.mockResolvedValue(
    models.map((id) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'local:ollama',
      state: 'loaded',
      backend: 'ollama',
      modality: ['text'],
      local: true,
    })),
  );

  const repoAsReal = repo as unknown as HubPoolPeerRepository;
  const pressureService = mock<HubPoolPressureService>();
  pressureService.band.mockReturnValue(null);
  pressureService.source.mockReturnValue(null);
  const service = new HubPoolPeerService(
    mock<LoggerService>(),
    repoAsReal,
    tailscaleService,
    tailscaleAdminApi,
    encryption,
    inferenceRouter,
    new HubPoolLoadService(),
    configuration,
    pressureService,
  );
  const controller = new HubPoolController(service, mock<PoolProxyService>(), tailscaleService, configuration, new HubPoolRoutingLogService());

  return {
    fqdn,
    repo,
    service,
    controller,
    guard: new PoolPeerGuard(repoAsReal),
    /** Make this node report a measured band, as its sampler would. */
    setGpuPressure(band: number | null, source: 'host-file' | 'amd-drm' | null = band === null ? null : 'amd-drm') {
      pressureService.band.mockReturnValue(band);
      pressureService.source.mockReturnValue(source);
    },
    configuration,
    setPoolEnabled(enabled: boolean) {
      preferences.poolEnabled = enabled;
    },
    setInboundEnabled(enabled: boolean) {
      preferences.poolInboundEnabled = enabled;
    },
    setOutboundEnabled(enabled: boolean) {
      preferences.poolOutboundEnabled = enabled;
    },
    setPeerEnabled: async (id: string, enabled: boolean) => {
      await service.setPeerEnabled(id, enabled);
    },
    poll: () => (service as unknown as { refreshPeerHealth: () => Promise<void> }).refreshPeerHealth(),
  };
}

function headerLookup(init: RequestInit | undefined): (name: string) => string | undefined {
  const raw = (init?.headers ?? {}) as Record<string, string>;
  const lower = new Map(Object.entries(raw).map(([key, value]) => [key.toLowerCase(), value]));
  return (name: string) => lower.get(name.toLowerCase());
}

/** Nest exceptions become the HTTP status the calling Hub would actually see. */
function toResponse(handler: () => Promise<unknown>): Promise<Response> {
  return handler().then(
    (body) => new Response(JSON.stringify(body ?? {}), { status: 200, headers: { 'content-type': 'application/json' } }),
    (error: unknown) => {
      const status = error instanceof HttpException ? error.getStatus() : 500;
      return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), { status });
    },
  );
}

/**
 * Routes `https://<fqdn>/api/inference/pool/...` to that node's real controller, through its real
 * guard. Anything else — an unreachable node, an unknown route — rejects the way `fetch` would.
 */
function installFetchRouter(nodes: Node[], options: { offline?: Set<string> } = {}): void {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (options.offline?.has(url.hostname)) {
      throw new TypeError('fetch failed');
    }
    const node = nodes.find((candidate) => candidate.fqdn === url.hostname);
    if (!node) {
      throw new TypeError(`fetch failed: no route to ${url.hostname}`);
    }

    const header = headerLookup(init);
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, string>) : {};
    const request = { header, poolPeer: undefined } as unknown as Request;
    const path = url.pathname.replace('/api/inference/pool', '');

    if (path === '/pair/request') {
      return toResponse(() => node.controller.handlePairingRequest(body as never));
    }

    // Everything below is peer-facing, so the real guard decides whether the caller gets in at all.
    return toResponse(async () => {
      await node.guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) } as never);
      switch (path) {
        case '/pair/confirm':
          return node.controller.handlePairingConfirm(request, body as never);
        case '/pair/reject':
          return node.controller.handlePairingReject(request);
        case '/pair/unpair':
          return node.controller.handlePairingUnpair(request);
        case '/capabilities':
          return node.controller.capabilities(request);
        default:
          throw new TypeError(`fetch failed: no route for ${path}`);
      }
    });
  }) as typeof fetch;
}

describe('Hub Pool across two nodes', () => {
  let core: Node;
  let beta: Node;
  let offline: Set<string>;

  /** Core initiates, beta approves — the whole operator flow, end to end. */
  async function pairNodes(): Promise<void> {
    await core.service.initiatePairing(BETA_FQDN, 'Beta Hub');
    await beta.service.approvePairing(beta.repo.only().id);
  }

  beforeEach(() => {
    core = buildNode(CORE_FQDN, [SHARED_MODEL]);
    beta = buildNode(BETA_FQDN, [SHARED_MODEL, BETA_ONLY_MODEL]);
    offline = new Set<string>();
    installFetchRouter([core, beta], { offline });
  });

  describe('pairing handshake', () => {
    it('leaves each side connected holding exactly its half of the two-token exchange', async () => {
      await pairNodes();

      const coreRow = core.repo.only();
      const betaRow = beta.repo.only();
      expect(coreRow).toMatchObject({ nodeFqdn: BETA_FQDN, direction: 'outbound', status: 'connected' });
      expect(betaRow).toMatchObject({ nodeFqdn: CORE_FQDN, direction: 'inbound', status: 'connected' });

      // The property that matters: what each side presents is what the other side verifies. Swap the
      // two columns on either node and everything still looks paired, but no call ever authenticates.
      expect(hashToken(await core.service.getPresentToken(coreRow))).toBe(betaRow.verifyTokenHash);
      expect(hashToken(await beta.service.getPresentToken(betaRow))).toBe(coreRow.verifyTokenHash);
      // The two directions must not share one secret.
      expect(coreRow.verifyTokenHash).not.toBe(betaRow.verifyTokenHash);
    });

    it('produces credentials each node’s own guard accepts, in both directions', async () => {
      await pairNodes();

      await core.poll();
      await beta.poll();

      // Cached capabilities are only obtainable through the other node's PoolPeerGuard, so their
      // presence is proof the handshake produced a usable credential — and their contents prove the
      // probe reached the right node.
      const cachedOnCore = core.repo.only().lastCapabilities as unknown as PoolPeerCapabilities;
      expect(cachedOnCore.backends[0]?.modelsLoaded).toEqual([SHARED_MODEL, BETA_ONLY_MODEL]);
      const cachedOnBeta = beta.repo.only().lastCapabilities as unknown as PoolPeerCapabilities;
      expect(cachedOnBeta.backends[0]?.modelsLoaded).toEqual([SHARED_MODEL]);
      expect(core.repo.only().status).toBe('connected');
      expect(beta.repo.only().status).toBe('connected');
    });

    it('stores the peer under its canonical name, so a differently-spelled callback still resolves', async () => {
      await core.service.initiatePairing('Hub-B.Example-Tailnet.TS.NET.', 'Beta Hub');

      expect(core.repo.only().nodeFqdn).toBe(BETA_FQDN);

      // Beta's confirm callback identifies itself with its own canonical name; core's row has to be
      // findable by it or the pairing hangs at pending forever.
      await beta.service.approvePairing(beta.repo.only().id);

      expect(core.repo.only().status).toBe('connected');
    });

    it('rolls core back to nothing when beta refuses the request outright', async () => {
      beta.setPoolEnabled(false);

      await expect(core.service.initiatePairing(BETA_FQDN)).rejects.toThrow(/503/);

      // A pending row left behind would block the retry with a 409 once beta is switched back on.
      expect(core.repo.rows.size).toBe(0);
      expect(beta.repo.rows.size).toBe(0);
    });

    it('ignores a duplicate request rather than issuing a second token for the same peer', async () => {
      await pairNodes();
      const betaRowId = beta.repo.only().id;

      await beta.service.receivePairingRequest(CORE_FQDN, 'Core Hub', 'a-second-token');

      expect(beta.repo.rows.size).toBe(1);
      expect(beta.repo.only().id).toBe(betaRowId);
    });
  });

  describe('reject', () => {
    it('clears the pending row on both nodes', async () => {
      await core.service.initiatePairing(BETA_FQDN);

      await beta.service.rejectPairing(beta.repo.only().id);

      expect(beta.repo.rows.size).toBe(0);
      expect(core.repo.rows.size).toBe(0);
    });

    it('refuses a reject callback from a caller that does not hold the token core issued', async () => {
      await core.service.initiatePairing(BETA_FQDN);

      const response = await fetch(`https://${CORE_FQDN}/api/inference/pool/pair/reject`, {
        method: 'POST',
        headers: { 'X-Hub-Pool-Peer': BETA_FQDN, Authorization: 'Bearer not-the-issued-token' },
      });

      // Otherwise anyone on the tailnet could make an operator's pairing request silently vanish.
      expect(response.status).toBe(401);
      expect(core.repo.only().status).toBe('pending');
    });

    it('leaves an established pairing alone — reject only retires a request that never completed', async () => {
      await pairNodes();

      await fetch(`https://${CORE_FQDN}/api/inference/pool/pair/reject`, {
        method: 'POST',
        headers: { 'X-Hub-Pool-Peer': BETA_FQDN, Authorization: `Bearer ${await beta.service.getPresentToken(beta.repo.only())}` },
      });

      expect(core.repo.only().status).toBe('connected');
    });
  });

  describe('unpair and re-pair', () => {
    it('drops both halves and then pairs again cleanly', async () => {
      await pairNodes();

      await core.service.removePeer(core.repo.only().id);

      expect(core.repo.rows.size).toBe(0);
      // Without the callback beta keeps forwarding work to a node that now 401s it.
      expect(beta.repo.rows.size).toBe(0);

      await pairNodes();

      expect(core.repo.only().status).toBe('connected');
      expect(beta.repo.only().status).toBe('connected');
    });

    it('issues fresh tokens on the re-pair, so the revoked ones stop working', async () => {
      await pairNodes();
      const revoked = await core.service.getPresentToken(core.repo.only());

      await core.service.removePeer(core.repo.only().id);
      await pairNodes();

      const response = await fetch(`https://${BETA_FQDN}/api/inference/pool/capabilities`, {
        headers: { 'X-Hub-Pool-Peer': CORE_FQDN, Authorization: `Bearer ${revoked}` },
      });

      expect(response.status).toBe(401);
      expect(await core.service.getPresentToken(core.repo.only())).not.toBe(revoked);
    });
  });

  describe('an unpaired device on the tailnet', () => {
    it('cannot read a peer-facing route, even holding a token that is valid for someone else', async () => {
      await pairNodes();
      const betasRealToken = await beta.service.getPresentToken(beta.repo.only());

      const asStranger = await fetch(`https://${CORE_FQDN}/api/inference/pool/capabilities`, {
        headers: { 'X-Hub-Pool-Peer': 'laptop.example-tailnet.ts.net', Authorization: `Bearer ${betasRealToken}` },
      });
      const asBetaWithWrongToken = await fetch(`https://${CORE_FQDN}/api/inference/pool/capabilities`, {
        headers: { 'X-Hub-Pool-Peer': BETA_FQDN, Authorization: 'Bearer guessed' },
      });

      expect(asStranger.status).toBe(401);
      expect(asBetaWithWrongToken.status).toBe(401);
    });

    it('cannot read capabilities while its pairing is still pending approval', async () => {
      await core.service.initiatePairing(BETA_FQDN);

      // Beta holds core's token, so the guard admits it — the handler is what must still refuse.
      const response = await fetch(`https://${CORE_FQDN}/api/inference/pool/capabilities`, {
        headers: { 'X-Hub-Pool-Peer': BETA_FQDN, Authorization: `Bearer ${await beta.service.getPresentToken(beta.repo.only())}` },
      });

      expect(response.status).toBe(403);
    });
  });

  describe('recovery', () => {
    it('marks a peer that left the tailnet unreachable on the third strike, not the first', async () => {
      await pairNodes();
      offline.add(BETA_FQDN);

      await core.poll();
      expect(core.repo.only()).toMatchObject({ status: 'connected', consecutiveFailures: 1 });
      await core.poll();
      expect(core.repo.only()).toMatchObject({ status: 'connected', consecutiveFailures: 2 });
      await core.poll();
      expect(core.repo.only()).toMatchObject({ status: 'unreachable', consecutiveFailures: 3 });
    });

    it('brings the peer back on the first good probe after it returns, with no operator action', async () => {
      await pairNodes();
      offline.add(BETA_FQDN);
      for (let i = 0; i < 3; i += 1) await core.poll();
      expect(core.repo.only().status).toBe('unreachable');

      offline.delete(BETA_FQDN);
      await core.poll();

      expect(core.repo.only()).toMatchObject({ status: 'connected', consecutiveFailures: 0 });
      // Re-cached from the peer itself, so it is again a routing candidate for the models it holds.
      const cached = core.repo.only().lastCapabilities as unknown as PoolPeerCapabilities;
      expect(cached.backends[0]?.modelsLoaded).toContain(BETA_ONLY_MODEL);
    });

    it('keeps the pairing intact throughout, so recovery never needs a re-pair', async () => {
      await pairNodes();
      const pairedId = core.repo.only().id;
      offline.add(BETA_FQDN);
      for (let i = 0; i < 4; i += 1) await core.poll();

      offline.delete(BETA_FQDN);
      await core.poll();

      expect(core.repo.only().id).toBe(pairedId);
      expect(beta.repo.only().status).toBe('connected');
    });
  });

  describe('kill switch', () => {
    // Exercised through the persisted setting rather than HUB_POOL_USER_DISABLED: both nodes share
    // one `process.env` here, and the point is that ONE node stops answering. The env override's own
    // precedence is covered in hub-pool-peer.service.test.ts.
    it('makes the disabled node refuse capability probes outright instead of reporting an empty inventory', async () => {
      await pairNodes();
      beta.setPoolEnabled(false);

      const response = await fetch(`https://${BETA_FQDN}/api/inference/pool/capabilities`, {
        headers: { 'X-Hub-Pool-Peer': CORE_FQDN, Authorization: `Bearer ${await core.service.getPresentToken(core.repo.only())}` },
      });

      // An empty-but-successful answer would be cached as beta's capabilities and never expire.
      expect(response.status).toBe(503);
    });

    it('drives the peer to unreachable on the far node while keeping the pairing', async () => {
      await pairNodes();
      beta.setPoolEnabled(false);

      for (let i = 0; i < 3; i += 1) await core.poll();

      expect(core.repo.only().status).toBe('unreachable');
      expect(beta.repo.only().status).toBe('connected');
    });

    it('recovers within one poll of the switch being turned back on', async () => {
      await pairNodes();
      beta.setPoolEnabled(false);
      for (let i = 0; i < 3; i += 1) await core.poll();

      beta.setPoolEnabled(true);
      await core.poll();

      expect(core.repo.only()).toMatchObject({ status: 'connected', consecutiveFailures: 0 });
    });

    it('refuses a new pairing request while it is off', async () => {
      beta.setPoolEnabled(false);

      await expect(core.service.initiatePairing(BETA_FQDN)).rejects.toThrow();

      expect(beta.repo.rows.size).toBe(0);
    });
  });

  /**
   * The directional and per-peer switches, across the wire — which is the only place their point is
   * visible. Each one is asymmetric by design: what it means locally and what the node at the other
   * end observes are different, and a single-node test cannot tell those apart.
   */
  describe('directional and per-peer kill switches', () => {
    /** What `refreshOnePeer` cached about the other node on its last poll. */
    function cachedOn(node: Node): PoolPeerCapabilities {
      return node.repo.only().lastCapabilities as unknown as PoolPeerCapabilities;
    }

    /**
     * A `local/*` forward from core to beta, through beta's REAL guard and controller. Driven
     * directly rather than through the fetch router because `local/*` is the one peer-facing route
     * the router does not carry — it takes an Express `Response` the router has nothing to give it.
     */
    async function betaLocalForward(coreToken: string): Promise<number> {
      let statusCode = 0;
      const res = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json() {
          return this;
        },
      };
      const request = {
        poolPeer: undefined,
        header: (name: string) =>
          ({ 'x-hub-pool-peer': CORE_FQDN, authorization: `Bearer ${coreToken}`, 'x-hub-pool-backend': 'ollama' })[name.toLowerCase()],
      } as unknown as Request;
      await beta.guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) } as never);
      await beta.controller.localOllamaChat(request, { model: SHARED_MODEL }, res as never);
      return statusCode;
    }

    it('lets beta stop serving while still using core — the asymmetry the feature exists for', async () => {
      await pairNodes();
      beta.setInboundEnabled(false);

      await core.poll();
      await beta.poll();

      // Core still polls beta successfully — beta is up, so it must not read as unreachable.
      expect(core.repo.only()).toMatchObject({ status: 'connected', consecutiveFailures: 0 });
      expect(cachedOn(core)).toMatchObject({ acceptingWork: false, backends: [], hardwareTier: 'high' });
      // ...and beta's own view of core is untouched: it keeps sending work out.
      expect(cachedOn(beta)).toMatchObject({ acceptingWork: true });
      expect(cachedOn(beta).backends[0]?.modelsLoaded).toContain(SHARED_MODEL);
    });

    it('refuses a forward from a peer it is not serving with 503, so the sender fails over', async () => {
      await pairNodes();
      beta.setInboundEnabled(false);
      const token = await core.service.getPresentToken(core.repo.only());

      // Never 403: that is what the sender reads as "it no longer considers us paired", which would
      // drop a healthy pairing's cached capabilities on every request.
      expect(await betaLocalForward(token)).toBe(503);
    });

    it('keeps accepting new pairing requests with inbound off, because pairing is a trust decision', async () => {
      beta.setInboundEnabled(false);

      await core.service.initiatePairing(BETA_FQDN);

      expect(beta.repo.only()).toMatchObject({ direction: 'inbound', status: 'pending' });
    });

    it('takes one peer out of the pool from beta’s side, in both directions, without touching the pairing', async () => {
      await pairNodes();
      await beta.setPeerEnabled(beta.repo.only().id, false);
      const token = await core.service.getPresentToken(core.repo.only());

      await core.poll();

      expect(cachedOn(core)).toMatchObject({ acceptingWork: false, backends: [] });
      expect(await betaLocalForward(token)).toBe(503);
      // The pairing and both tokens survive — this is not a revocation.
      expect(core.repo.only()).toMatchObject({ status: 'connected', consecutiveFailures: 0 });
      expect(beta.repo.only().presentTokenEncrypted).toBeTruthy();
    });

    it('restores routing within one poll of the switch going back on, with no re-approval', async () => {
      await pairNodes();
      beta.setInboundEnabled(false);
      await core.poll();
      expect(cachedOn(core).backends).toEqual([]);

      beta.setInboundEnabled(true);
      await core.poll();

      expect(cachedOn(core)).toMatchObject({ acceptingWork: true });
      expect(cachedOn(core).backends[0]?.modelsLoaded).toContain(BETA_ONLY_MODEL);
    });

    it('keeps polling a disabled peer, so the status card stays honest and re-enabling is instant', async () => {
      await pairNodes();
      await core.setPeerEnabled(core.repo.only().id, false);

      await core.poll();

      // Disabling is a routing decision; it must not make a live machine look down.
      expect(core.repo.only()).toMatchObject({ status: 'connected', enabled: false, consecutiveFailures: 0 });
      expect(cachedOn(core).backends[0]?.modelsLoaded).toContain(BETA_ONLY_MODEL);
    });

    it('leaves core’s inbound serving alone when core stops SENDING work', async () => {
      await pairNodes();
      core.setOutboundEnabled(false);
      const token = await beta.service.getPresentToken(beta.repo.only());

      await beta.poll();

      // Outbound is about what this node sends; beta must still see a fully serving core.
      expect(cachedOn(beta)).toMatchObject({ acceptingWork: true });
      expect(cachedOn(beta).backends[0]?.modelsLoaded).toContain(SHARED_MODEL);
      expect(token).toBeTruthy();
    });
  });

  describe('GPU pressure across the wire', () => {
    /** What `refreshOnePeer` cached about the other node on its last poll. */
    function cachedOn(node: Node): PoolPeerCapabilities {
      return node.repo.only().lastCapabilities as unknown as PoolPeerCapabilities;
    }

    it('carries a measured band from core through /capabilities into beta’s cached snapshot', async () => {
      await pairNodes();
      core.setGpuPressure(2);

      await beta.poll();

      // No new route, no migration: the band rides the existing authenticated capabilities probe and
      // lands in the `last_capabilities` jsonb column that already exists.
      expect(cachedOn(beta)).toMatchObject({ gpuPressure: 2, gpuPressureSource: 'amd-drm' });
    });

    it('leaves the keys off the wire entirely when core cannot measure', async () => {
      await pairNodes();
      core.setGpuPressure(null);

      await beta.poll();

      // Beta then ranks core at UNKNOWN_PRESSURE. Sending 0 here would have told beta that a node
      // which has no GPU counter at all is the idlest machine in the pool.
      expect(cachedOn(beta)).not.toHaveProperty('gpuPressure');
      expect(cachedOn(beta)).not.toHaveProperty('gpuPressureSource');
    });

    it('surfaces the peer band on beta’s own status card', async () => {
      await pairNodes();
      core.setGpuPressure(3);
      await beta.poll();

      const status = await beta.service.getPoolStatus();

      expect(status.peers[0]?.gpuPressure).toBe(3);
    });

    it('reports null for the peer while beta itself has never measured anything', async () => {
      await pairNodes();
      core.setGpuPressure(null);
      await beta.poll();

      const status = await beta.service.getPoolStatus();

      expect(status.peers[0]?.gpuPressure).toBeNull();
      expect(status.localNode.gpuPressure).toBeNull();
    });

    it('is unaffected by a peer on an older build, whose payload simply omits the key', async () => {
      await pairNodes();
      core.setGpuPressure(null);

      await beta.poll();
      const status = await beta.service.getPoolStatus();

      // Compatibility runs both ways: an older peer omits the field and ranks neutral, and a newer
      // peer's extra keys are ignored by an older node's structural read of `capabilities.backends`.
      expect(cachedOn(beta).backends[0]?.modelsLoaded).toContain(SHARED_MODEL);
      expect(status.peers[0]?.status).toBe('connected');
    });
  });
});
