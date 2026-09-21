import { createHash, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
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
import { InferenceBackendRegistry } from '@/modules/inference/backends/backend-registry';
import { DsparkBackend } from '@/modules/inference/backends/dspark.backend';
import { LemonadeBackend } from '@/modules/inference/backends/lemonade.backend';
import { LuceboxBackend } from '@/modules/inference/backends/lucebox.backend';
import { MtplxBackend } from '@/modules/inference/backends/mtplx.backend';
import { OllamaBackend } from '@/modules/inference/backends/ollama.backend';
import { VllmBackend } from '@/modules/inference/backends/vllm.backend';
import type { HubPoolPeer, NewHubPoolPeer } from '@/core/database/drizzle/types';
import {
  DEFAULT_POOL_HEALTH_POLL_SECONDS,
  DEFAULT_POOL_LOCAL_AFFINITY,
  DEFAULT_POOL_PRESSURE_WEIGHT,
  DEFAULT_POOL_PREFIX_AFFINITY_MAX_IN_FLIGHT,
  DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS,
  POOL_CONTAINER_SAMPLER,
  type HubPoolPreferences,
  type PoolContainerRollup,
  type PoolContainerSampler,
} from '@/common/helpers/hub-pool';
import { ModuleRef } from '@nestjs/core';
import { HubPoolPressureService } from '../hub-pool-pressure.service';
import { HubPoolPeerRepository } from '../hub-pool-peer.repository';
import { HubPoolPeerService } from '../hub-pool-peer.service';
import { HubPoolIdentityRepository, type HubPoolIdentityRow } from '../hub-pool-identity.repository';
import { HubPoolIdentityService } from '../hub-pool-identity.service';
import { HubPoolPairingPinService } from '../hub-pool-pairing-pin.service';
import { HubPoolLoadService } from '../hub-pool-load.service';
import { HubPoolRoutingLogService } from '../hub-pool-routing-log.service';
import { POOL_REQUEST_ID_HEADER, POOL_SERVED_BY_HEADER, PoolProxyService } from '../hub-pool-proxy.service';
import { HubPoolPinService } from '../hub-pool-pin.service';
import { HubPoolThroughputService } from '../hub-pool-throughput.service';
import { HubPoolDiscoveryService } from '../hub-pool-discovery.service';
import { HubPoolController } from '../hub-pool.controller';
import { PoolPeerGuard } from '../guards/pool-peer.guard';
import type { PoolPeerCapabilities } from '../hub-pool.types';
import { publicKeyFingerprint } from '../hub-pool-peer-auth';

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
/** Beta as an operator finds it on the LAN, with no Tailscale OAuth client anywhere in the picture. */
const BETA_ADDRESS = '192.168.1.42:5002';
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

  /** Backed by the partial unique index in migration 0059, which {@link update} enforces below. */
  async findByNodeUuid(peerNodeUuid: string): Promise<HubPoolPeer | undefined> {
    return [...this.rows.values()].find((row) => row.peerNodeUuid === peerNodeUuid);
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
    // Both unique constraints, enforced here so "follow a renamed peer" and "pin an identity" are
    // only real tests if a collision would actually have thrown in Postgres.
    if ([...this.rows.values()].some((row) => row.id !== id && row.nodeFqdn === next.nodeFqdn)) {
      throw new Error('duplicate key value violates unique constraint "hub_pool_peer_node_fqdn_unique"');
    }
    if (next.peerNodeUuid && [...this.rows.values()].some((row) => row.id !== id && row.peerNodeUuid === next.peerNodeUuid)) {
      throw new Error('duplicate key value violates unique constraint "hub_pool_peer_node_uuid_uidx"');
    }
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

/** In-memory `hub_pool_identity`. One row, and `insertIfAbsent` really is a no-op when it is taken. */
class FakeIdentityRepository {
  row: HubPoolIdentityRow | undefined;

  async get(): Promise<HubPoolIdentityRow | undefined> {
    return this.row;
  }

  async insertIfAbsent(values: Omit<HubPoolIdentityRow, 'id' | 'createdAt' | 'rotatedAt'>): Promise<void> {
    this.row ??= { id: 'self', createdAt: new Date().toISOString(), rotatedAt: null, ...values };
  }

  async replaceKeys(publicKey: string, privateKeyEncrypted: string): Promise<void> {
    if (this.row) {
      this.row = { ...this.row, publicKey, privateKeyEncrypted, rotatedAt: new Date().toISOString() };
    }
  }
}

interface Node {
  fqdn: string;
  repo: FakePeerRepository;
  service: HubPoolPeerService;
  controller: HubPoolController;
  guard: PoolPeerGuard;
  identity: HubPoolIdentityService;
  configuration: MockProxy<ConfigurationService>;
  setPoolEnabled(enabled: boolean): void;
  setInboundEnabled(enabled: boolean): void;
  setOutboundEnabled(enabled: boolean): void;
  /** Take one peer of this node out of the pool, as the operator switch does. */
  setPeerEnabled(id: string, enabled: boolean): Promise<void>;
  /** Make this node's runtime monitor report a sample, or `null` for "nothing collected". */
  setContainerSample(rollup: PoolContainerRollup | null): void;
  /** Stop sharing container figures with peers, as the operator switch does. */
  setShareContainerStats(enabled: boolean): void;
  /** Set or clear this node's stored prompt ceiling, as a settings PATCH does. */
  setMaxPromptTokens(tokens: number | null): void;
  /** What this node's proxy has timed, and what its `/capabilities` advertises from. */
  throughput: HubPoolThroughputService;
  /** Runs one health-poll tick, as the module's own timer would. */
  poll(): Promise<void>;
  /** Give this node a new MagicDNS name, as a tailnet rename would — routing and self-report together. */
  rename(fqdn: string): void;
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
    poolPins: [],
    poolRequireSignedPeers: false,
    poolShareContainerStats: true,
    poolPressureWeight: DEFAULT_POOL_PRESSURE_WEIGHT,
    poolMaxPromptTokens: null,
    poolProbeSnapshotTtlMs: DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS,
    poolPrefixAffinityMaxInFlight: DEFAULT_POOL_PREFIX_AFFINITY_MAX_IN_FLIGHT,
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
  let selfFqdn = fqdn;
  tailscaleService.getStatusCached.mockImplementation(async () => ({
    installed: true,
    connected: true,
    version: '1.90.0',
    hostname: selfFqdn.split('.')[0] as string,
    nodeFqdn: selfFqdn,
    tailnet: TAILNET,
    ip: '100.64.0.1',
    supportsServices: true,
    httpsAvailable: true,
    backendState: 'Running',
    authUrl: null,
  }));

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
  // A real identity service over a fake table: the keypair, the encryption round-trip and the
  // "never re-mint" rule are all part of what these two nodes are testing.
  const identity = new HubPoolIdentityService(
    mock<LoggerService>(),
    new FakeIdentityRepository() as unknown as HubPoolIdentityRepository,
    encryption,
  );
  const pairingPins = new HubPoolPairingPinService(mock<LoggerService>());
  const pressureService = mock<HubPoolPressureService>();
  pressureService.band.mockReturnValue(null);
  pressureService.source.mockReturnValue(null);
  // Stands in for `AppRuntimeMonitorService`, which the real pool reaches through this token. No
  // sample by default, so every pre-existing assertion here runs against a node that reports no
  // containers at all — which is what an un-sampled Hub genuinely is.
  const containerSampler = mock<PoolContainerSampler>();
  containerSampler.containerRollup.mockReturnValue(null);
  const throughput = new HubPoolThroughputService();
  const moduleRef = mock<ModuleRef>();
  moduleRef.get.mockImplementation((token: unknown) => {
    if (token === POOL_CONTAINER_SAMPLER) {
      return containerSampler as never;
    }
    throw new Error(`Nest could not find ${String(token)}`);
  });
  const service = new HubPoolPeerService(
    mock<LoggerService>(),
    repoAsReal,
    tailscaleService,
    tailscaleAdminApi,
    encryption,
    inferenceRouter,
    new HubPoolLoadService(),
    configuration,
    identity,
    pairingPins,
    pressureService,
    moduleRef,
    throughput,
  );
  // A REAL discovery service over the real peer service: pairing by address runs the address parse,
  // the private-address check, the `/identify` probe and the PIN handshake for real, which is the
  // only way this file can catch the two halves drifting apart again.
  const discovery = new HubPoolDiscoveryService(mock<LoggerService>(), service);
  const controller = new HubPoolController(
    service,
    mock<PoolProxyService>(),
    tailscaleService,
    configuration,
    new HubPoolRoutingLogService(),
    discovery,
  );

  const built: Node = {
    fqdn,
    repo,
    service,
    controller,
    guard: new PoolPeerGuard(repoAsReal, identity, configuration, mock<LoggerService>()),
    identity,
    /** Make this node's runtime monitor report a sample, or `null` for "nothing collected". */
    setContainerSample(rollup: PoolContainerRollup | null) {
      containerSampler.containerRollup.mockReturnValue(rollup);
    },
    /** Stop sharing container figures with peers, as the operator switch does. */
    setShareContainerStats(enabled: boolean) {
      preferences.poolShareContainerStats = enabled;
    },
    setMaxPromptTokens(tokens: number | null) {
      preferences.poolMaxPromptTokens = tokens;
    },
    throughput,
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
    rename(next: string) {
      selfFqdn = next;
      node.fqdn = next;
    },
  };
  const node = built;
  return node;
}

function headerLookup(init: RequestInit | undefined): (name: string) => string | undefined {
  const raw = (init?.headers ?? {}) as Record<string, string>;
  const lower = new Map(Object.entries(raw).map(([key, value]) => [key.toLowerCase(), value]));
  return (name: string) => lower.get(name.toLowerCase());
}

/**
 * Nest exceptions become the HTTP status the calling Hub would actually see, carrying any headers the
 * guard set on the response before it threw (the global exception filter keeps those too).
 */
function toResponse(handler: () => Promise<unknown>, responseHeaders: Headers = new Headers()): Promise<Response> {
  return handler().then(
    (body) => new Response(JSON.stringify(body ?? {}), { status: 200, headers: { 'content-type': 'application/json' } }),
    (error: unknown) => {
      const status = error instanceof HttpException ? error.getStatus() : 500;
      return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), { status, headers: responseHeaders });
    },
  );
}

/**
 * Routes `https://<fqdn>/api/inference/pool/...` to that node's real controller, through its real
 * guard. Anything else — an unreachable node, an unknown route — rejects the way `fetch` would.
 */
function installFetchRouter(nodes: Node[], options: { offline?: Set<string>; addresses?: Map<string, Node> } = {}): void {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (options.offline?.has(url.hostname)) {
      throw new TypeError('fetch failed');
    }
    // `addresses` is the LAN half: a node reachable at `192.168.1.42:5002` and NOT by name, which is
    // the configuration pairing-by-address exists for.
    const node = nodes.find((candidate) => candidate.fqdn === url.hostname) ?? options.addresses?.get(url.host);
    if (!node) {
      throw new TypeError(`fetch failed: no route to ${url.hostname}`);
    }

    const header = headerLookup(init);
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, string>) : {};
    // `method`, `originalUrl` and `body` are what the signature covers, so the fake request has to
    // carry them or a signed call would verify against the wrong message here and only here.
    const request = {
      header,
      poolPeer: undefined,
      method: (init?.method ?? 'GET').toUpperCase(),
      originalUrl: url.pathname,
      url: url.pathname,
      path: url.pathname,
      body,
      ip: '100.64.0.9',
    } as unknown as Request;
    const path = url.pathname.replace('/api/inference/pool', '');

    if (path === '/identify') {
      return toResponse(() => node.controller.identify());
    }

    if (path === '/pair/request') {
      return toResponse(() => node.controller.handlePairingRequest(request, body as never));
    }

    // Everything below is peer-facing, so the real guard decides whether the caller gets in at all.
    const responseHeaders = new Headers();
    const response = { setHeader: (name: string, value: string) => responseHeaders.set(name, value) };
    return toResponse(async () => {
      await node.guard.canActivate({ switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) } as never);
      switch (path) {
        case '/pair/confirm':
          return node.controller.handlePairingConfirm(request, body as never);
        case '/pair/reject':
          return node.controller.handlePairingReject(request);
        case '/pair/unpair':
          return node.controller.handlePairingUnpair(request);
        case '/pair/upgrade':
          return node.controller.handlePairingUpgrade(request, body as never);
        case '/capabilities':
          return node.controller.capabilities(request);
        default:
          throw new TypeError(`fetch failed: no route for ${path}`);
      }
    }, responseHeaders);
  }) as typeof fetch;
}

describe('Hub Pool across two nodes', () => {
  let core: Node;
  let beta: Node;
  let offline: Set<string>;
  /** Nodes reachable only at a LAN authority — no MagicDNS route to them at all. */
  let addresses: Map<string, Node>;

  /** Core initiates, beta approves — the whole operator flow, end to end. */
  async function pairNodes(): Promise<void> {
    await core.service.initiatePairing(BETA_FQDN, 'Beta Hub');
    await beta.service.approvePairing(beta.repo.only().id);
  }

  beforeEach(() => {
    core = buildNode(CORE_FQDN, [SHARED_MODEL]);
    beta = buildNode(BETA_FQDN, [SHARED_MODEL, BETA_ONLY_MODEL]);
    offline = new Set<string>();
    addresses = new Map<string, Node>();
    installFetchRouter([core, beta], { offline, addresses });
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

  describe('peer identity: PIN pairing, pinning and the bearer upgrade', () => {
    /** What each node cached about the other on its last successful capability probe. */
    function cached(node: Node): PoolPeerCapabilities {
      return node.repo.only().lastCapabilities as unknown as PoolPeerCapabilities;
    }

    /** Wind a row back to what migration 0058 left behind: paired, tokens only, nothing pinned. */
    async function rewindToBearerOnly(node: Node): Promise<void> {
      await node.repo.update(node.repo.only().id, { peerNodeUuid: null, peerPublicKey: null, bearerGraceUntil: null, signedSeenAt: null });
    }

    /**
     * Run health ticks until both sides have settled onto signatures.
     *
     * Three rounds, and the cost is inherent rather than incidental: the upgrade responder keeps
     * presenting its bearer token until it has *seen* the initiator sign, so each side needs one
     * tick to exchange keys, one to be observed signing, and one to retire its tokens.
     */
    async function converge(): Promise<void> {
      for (let round = 0; round < 3; round += 1) {
        await core.poll();
        await beta.poll();
      }
    }

    it('pins each side to the other’s key on a plain protocol-1 pairing, over the authenticated confirm call', async () => {
      await pairNodes();

      // No PIN anywhere here: the identity claims travel on `pair/confirm`, which PoolPeerGuard has
      // already authenticated, so the legacy request/approve flow ends up pinned too.
      expect(core.repo.only().peerNodeUuid).toBe((await beta.service.identitySummary()).nodeUuid);
      expect(beta.repo.only().peerNodeUuid).toBe((await core.service.identitySummary()).nodeUuid);
      expect(core.repo.only().peerPublicKey).toBeTruthy();
      expect(beta.repo.only().peerPublicKey).toBeTruthy();
    });

    it('pairs with a PIN, pins both identities, and still lands PENDING for the operator to confirm', async () => {
      const { pin } = beta.service.mintPairingPin();

      await core.service.initiatePairing(BETA_FQDN, 'Beta Hub', pin);

      // Q3: a PIN authenticates the REQUEST; it does not stand in for the operator seeing who is
      // asking. A PIN read aloud, or over a shoulder, must not get a node connected and spending GPU.
      const betaRow = beta.repo.only();
      expect(betaRow).toMatchObject({ status: 'pending', direction: 'inbound' });
      // …but the claim IS authenticated now, so the confirm screen can show a real fingerprint.
      expect(betaRow.peerNodeUuid).toBe((await core.service.identitySummary()).nodeUuid);
      expect(publicKeyFingerprint(betaRow.peerPublicKey)).toBe((await core.service.identitySummary()).publicKeyFingerprint);
      // And core learned beta's identity from beta's answer, inside the TLS session core opened.
      expect(publicKeyFingerprint(core.repo.only().peerPublicKey)).toBe((await beta.service.identitySummary()).publicKeyFingerprint);

      await beta.service.approvePairing(betaRow.id);
      expect(beta.repo.only().status).toBe('connected');
      expect(core.repo.only().status).toBe('connected');
    });

    it('reports an outstanding PIN without ever re-serving the digits', async () => {
      const { pin, expiresAt } = beta.service.mintPairingPin();

      const status = await beta.service.getPoolStatus();

      expect(status.pairingPin).toEqual({ active: true, expiresAt });
      expect(JSON.stringify(status)).not.toContain(pin);
    });

    it('leaves NOTHING on either side when the PIN is wrong', async () => {
      beta.service.mintPairingPin();

      await expect(core.service.initiatePairing(BETA_FQDN, 'Beta Hub', '000000')).rejects.toThrow(/401/);

      // The whole point of the PIN: a bad request creates no pending slot and plants no outbound
      // token, so it can neither squat the approval list nor 401 beta's real calls to core forever.
      expect(beta.repo.rows.size).toBe(0);
      expect(core.repo.rows.size).toBe(0);
    });

    it('refuses a PIN that has already been spent', async () => {
      const { pin } = beta.service.mintPairingPin();
      await core.service.initiatePairing(BETA_FQDN, 'Beta Hub', pin);
      await beta.service.approvePairing(beta.repo.only().id);
      await core.service.removePeer(core.repo.only().id);

      await expect(core.service.initiatePairing(BETA_FQDN, 'Beta Hub', pin)).rejects.toThrow(/401/);
    });

    it('upgrades an existing bearer pairing to signatures off the health tick, and both sides converge', async () => {
      await pairNodes();
      await rewindToBearerOnly(core);
      await rewindToBearerOnly(beta);

      await core.poll();

      // Core initiated the exchange, so it learned beta's key from a RESPONSE and can sign at once;
      // beta learned core's from a REQUEST and keeps presenting its bearer token until it sees core
      // sign, because its own reply carrying its key may never have arrived.
      expect(core.repo.only().peerPublicKey).toBeTruthy();
      expect(beta.repo.only().peerPublicKey).toBeTruthy();
      expect(beta.repo.only().bearerGraceUntil).not.toBeNull();

      await converge();

      // Once each side has observed the other signing, both bearer tokens are retired — an old
      // database backup then holds tokens that authenticate nowhere.
      expect(core.repo.only()).toMatchObject({ verifyTokenHash: null, presentTokenEncrypted: null, bearerGraceUntil: null });
      expect(beta.repo.only()).toMatchObject({ verifyTokenHash: null, presentTokenEncrypted: null, bearerGraceUntil: null });
      expect(cached(core).backends[0]?.modelsLoaded).toContain(BETA_ONLY_MODEL);
    });

    it('keeps routing while only one side has upgraded, which is the whole mixed-fleet requirement', async () => {
      await pairNodes();
      await rewindToBearerOnly(core);
      await rewindToBearerOnly(beta);

      // Core upgrades; beta is left on the bearer token for a full extra round of polls.
      await core.poll();
      await core.poll();

      expect(core.repo.only().status).toBe('connected');
      expect(beta.repo.only().status).toBe('connected');
      expect(cached(core).backends[0]?.modelsLoaded).toContain(BETA_ONLY_MODEL);
    });

    it('rolls a pinned key back when the far side never signs, instead of locking the peer out', async () => {
      await pairNodes();
      // A grace window that has already closed with no signed request ever observed.
      await beta.repo.update(beta.repo.only().id, { signedSeenAt: null, bearerGraceUntil: new Date(Date.now() - 1).toISOString() });

      await beta.poll();

      // Rolled back, not enforced: enforcing would 401 a peer that is behaving correctly, and the
      // key can always be re-learned over the same authenticated channel on a later tick.
      expect(beta.repo.only()).toMatchObject({ peerNodeUuid: null, peerPublicKey: null, bearerGraceUntil: null, status: 'connected' });
    });

    it('follows a renamed peer by identity, which a bearer-only pairing could never do', async () => {
      await pairNodes();
      await converge();

      // Beta gets a new MagicDNS name. Core still holds the old one, so core's own poll can no
      // longer reach it — but beta's next signed call carries the new name, authenticated.
      const renamed = 'hub-b2.example-tailnet.ts.net';
      beta.rename(renamed);

      await beta.poll();
      await core.poll();

      expect(core.repo.only().nodeFqdn).toBe(renamed);
      expect(cached(core).backends[0]?.modelsLoaded).toContain(BETA_ONLY_MODEL);
    });

    it('rotates this node’s key, tells every peer first, and only then drops the rows', async () => {
      await pairNodes();
      const before = await core.service.identitySummary();

      const result = await core.service.rotateIdentity();

      // The unpair goes out BEFORE the key is destroyed — afterwards there is nothing core could
      // send that beta would believe.
      expect(result.unpaired).toEqual([BETA_FQDN]);
      expect(result.unreachable).toEqual([]);
      expect(result.nodeUuid).toBe(before.nodeUuid);
      expect(result.publicKeyFingerprint).not.toBe(before.publicKeyFingerprint);
      expect(core.repo.rows.size).toBe(0);
      expect(beta.repo.rows.size).toBe(0);
    });

    it('names the peers a rotation could not reach, so the operator knows which rows are stale', async () => {
      await pairNodes();
      offline.add(BETA_FQDN);

      const result = await core.service.rotateIdentity();

      expect(result.unreachable).toEqual([BETA_FQDN]);
      expect(result.unpaired).toEqual([]);
      // Core's rows go either way: after the rotation it has no key with which to say anything else.
      expect(core.repo.rows.size).toBe(0);
    });

    it('does not disclose this node’s name, UUID or key on the unauthenticated identify probe', async () => {
      await pairNodes();

      expect(await core.controller.identify()).toEqual({ isCiHub: true, poolProtocol: 2 });

      // The UUID lives on the guarded capabilities route instead — beta had to authenticate for it.
      await beta.poll();
      expect(cached(beta).nodeUuid).toBe((await core.service.identitySummary()).nodeUuid);
    });

    it('refuses a bearer token once the peer has been observed signing — the no-downgrade rule, end to end', async () => {
      await pairNodes();
      await converge();

      // Both sides have retired their tokens by now, so re-planting one and presenting it is exactly
      // the downgrade an attacker with an old backup would attempt.
      const coreRow = core.repo.only();
      await beta.repo.update(beta.repo.only().id, { verifyTokenHash: hashToken('resurrected-token') });
      await core.repo.update(coreRow.id, { presentTokenEncrypted: `ENC(${coreRow.nodeFqdn}):resurrected-token`, peerPublicKey: null });

      await core.poll();

      // Core can no longer sign to beta (it dropped the pinned key), so it falls back to the token —
      // and beta refuses it, because it has seen core sign.
      expect(core.repo.only().consecutiveFailures).toBe(1);
    });
  });

  describe('pairing by address', () => {
    /**
     * The end-to-end shape of "find a peer by address" after `/identify` stopped disclosing this
     * node's MagicDNS name.
     *
     * Beta is reachable ONLY at a LAN authority here — `addresses`, not the FQDN router — so nothing
     * in this flow can quietly fall back to a name core already knew. The name has to come out of
     * the PIN-gated exchange or the pairing cannot complete at all.
     */
    it('learns the peer’s tailnet name from the PIN exchange and keys the row on it', async () => {
      addresses.set(BETA_ADDRESS, beta);
      const { pin } = beta.service.mintPairingPin();

      const paired = await core.controller.pairPeer({ address: BETA_ADDRESS, displayName: 'Beta Hub', pin } as never);

      // The address is used once, to reach the handshake. What gets stored is the name.
      expect(paired).toMatchObject({ nodeFqdn: BETA_FQDN, direction: 'outbound', status: 'pending' });
      expect(core.repo.only().nodeFqdn).toBe(BETA_FQDN);
      // ...and the identity that came back on the same authenticated answer is pinned, so this
      // pairing starts out signed rather than on a bearer token.
      expect(core.repo.only().peerNodeUuid).toBe((await beta.service.identitySummary()).nodeUuid);
    });

    it('completes through approval, so an address-found peer routes like any other', async () => {
      addresses.set(BETA_ADDRESS, beta);
      const { pin } = beta.service.mintPairingPin();

      await core.controller.pairPeer({ address: BETA_ADDRESS, displayName: 'Beta Hub', pin } as never);
      await beta.service.approvePairing(beta.repo.only().id);

      expect(core.repo.only()).toMatchObject({ nodeFqdn: BETA_FQDN, status: 'connected' });
      expect(beta.repo.only()).toMatchObject({ nodeFqdn: CORE_FQDN, status: 'connected' });
    });

    it('refuses a wrong PIN and leaves neither node holding a row', async () => {
      addresses.set(BETA_ADDRESS, beta);
      beta.service.mintPairingPin();

      await expect(core.controller.pairPeer({ address: BETA_ADDRESS, pin: '000000' } as never)).rejects.toThrow(/PIN/);

      expect(core.repo.rows.size).toBe(0);
      expect(beta.repo.rows.size).toBe(0);
    });

    it('does not disclose the name to a pairing request that carried no PIN', async () => {
      // The privacy half of the same decision: the name moved behind the PIN, it did not merely move
      // off `/identify`. An anonymous `pair/request` still gets today's bare acknowledgement.
      const answer = await beta.service.receivePairingRequest(CORE_FQDN, 'Core', 'a'.repeat(64), {});

      expect(answer).toEqual({});
    });

    it('answers a PIN-authenticated request with the name, and only then', async () => {
      const { pin } = beta.service.mintPairingPin();

      const answer = await beta.service.receivePairingRequest(CORE_FQDN, 'Core', 'a'.repeat(64), { pin });

      expect(answer.nodeFqdn).toBe(BETA_FQDN);
      expect(answer.nodeUuid).toBe((await beta.service.identitySummary()).nodeUuid);
    });

    it('refuses to pair with itself, and leaves no phantom request behind', async () => {
      // The old probe caught this by comparing FQDNs `/identify` had told it. The receiver now
      // catches it instead — it is the one party that knows its own name for certain, and catching
      // it there is what stops a self-probe creating an inbound row from itself.
      addresses.set(BETA_ADDRESS, core);
      const { pin } = core.service.mintPairingPin();

      await expect(core.controller.pairPeer({ address: BETA_ADDRESS, pin } as never)).rejects.toThrow(/itself/);
      expect(core.repo.rows.size).toBe(0);
    });

    it('reports an already-paired node by name instead of creating a second row', async () => {
      addresses.set(BETA_ADDRESS, beta);
      await pairNodes();
      const { pin } = beta.service.mintPairingPin();

      await expect(core.controller.pairPeer({ address: BETA_ADDRESS, pin } as never)).rejects.toThrow(BETA_FQDN);
      expect(core.repo.rows.size).toBe(1);
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

  describe('a peer whose Hub database was recreated', () => {
    /**
     * beta-max on 2026-09-16: a compose project-name fix created a fresh `ci_hub_pgdata`, so the same
     * machine, under the same name, came back with a new pool UUID and key and no peer rows. Modelled
     * as a new node at beta's name: that is exactly what core's probes reach.
     */
    function recreateBetaDatabase(): void {
      beta = buildNode(BETA_FQDN, [SHARED_MODEL, BETA_ONLY_MODEL]);
      installFetchRouter([core, beta], { offline, addresses });
    }

    /** Pair, then run ticks until both sides sign and have retired their bearer tokens, as a long-lived fleet pair has. */
    async function pairAndSettleOnSignatures(): Promise<void> {
      await pairNodes();
      for (let round = 0; round < 3; round += 1) {
        await core.poll();
        await beta.poll();
      }
      expect(core.repo.only()).toMatchObject({ status: 'connected', presentTokenEncrypted: null });
    }

    async function coreStatusOfBeta() {
      return (await core.service.getPoolStatus()).peers.find((peer) => peer.nodeFqdn === BETA_FQDN);
    }

    it('says the identity changed and how to re-pair, instead of an endless unexplained 401', async () => {
      await pairAndSettleOnSignatures();
      const pinnedBefore = core.repo.only().peerNodeUuid;
      recreateBetaDatabase();

      await core.poll();

      const reported = await coreStatusOfBeta();
      expect(reported?.probeFailure).toMatchObject({ kind: 'identity_changed', httpStatus: 401 });
      expect(reported?.probeFailure?.action).toContain(`cihub pool unpair ${BETA_FQDN}`);
      expect(reported?.status).toBe('unreachable');
      // Nothing about the new identity was trusted: the row still pins what the operator approved.
      expect(core.repo.only().peerNodeUuid).toBe(pinnedBefore);
    });

    it('backs off instead of probing the recreated node on every poll', async () => {
      await pairAndSettleOnSignatures();
      recreateBetaDatabase();
      await core.poll();
      const probesAfterFirst = vi.mocked(global.fetch).mock.calls.length;

      await core.poll();
      await core.poll();

      expect(vi.mocked(global.fetch).mock.calls.length).toBe(probesAfterFirst);
    });

    it('re-pairs cleanly by following the reported steps, and ends connected to the new identity', async () => {
      await pairAndSettleOnSignatures();
      recreateBetaDatabase();
      await core.poll();

      // (1) unpair here, (2) PIN on beta, (3) pair here with it, (4) approve on beta.
      await core.service.removePeer(core.repo.only().id);
      const { pin } = beta.service.mintPairingPin();
      await core.service.initiatePairing(BETA_FQDN, undefined, pin);
      await beta.service.approvePairing(beta.repo.only().id);
      await core.poll();

      const reported = await coreStatusOfBeta();
      expect(reported).toMatchObject({ status: 'connected', probeFailure: null });
      expect(core.repo.only().peerNodeUuid).toBe((await beta.identity.get())?.nodeUuid);
    });

    it('calls a bearer-era pairing that the recreated node no longer knows unauthorized, and still says what to check', async () => {
      // Straight after pairing core still presents its bearer token, which carries no recipient, so
      // the recreated node can only say "unknown peer". That is a different, weaker verdict.
      await pairNodes();
      recreateBetaDatabase();

      await core.poll();

      const reported = await coreStatusOfBeta();
      expect(reported?.probeFailure).toMatchObject({ kind: 'unauthorized', httpStatus: 401 });
      expect(reported?.probeFailure?.action).toContain(`cihub pool status on ${BETA_FQDN}`);
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

    /**
     * The deadlock this pair hit in the field, and the case every other test in this block misses:
     * they drive ONE side unreachable while the other stays `connected`, so the recovering probe is
     * always answered by a node that still considers the caller connected.
     *
     * Both sides go unreachable together whenever the partition is mutual — or when one node is
     * merely slow enough to blow three probe timeouts while its own polls are timing out too. From
     * there, recovery runs solely through a successful capabilities probe, so if a node refuses the
     * probe of a peer it has marked unreachable, both refuse each other and neither can ever return:
     * the counters run away past the threshold and Unpair is the operator's only move on a pairing
     * that was never broken. Observed as `capabilities probe ... failed (14/3): returned 403`.
     */
    it('recovers a pair that BOTH sides marked unreachable, instead of wedging on a mutual 403', async () => {
      await pairNodes();

      // A partition both sides notice.
      offline.add(CORE_FQDN);
      offline.add(BETA_FQDN);
      for (let i = 0; i < 3; i += 1) {
        await core.poll();
        await beta.poll();
      }
      expect(core.repo.only().status).toBe('unreachable');
      expect(beta.repo.only().status).toBe('unreachable');

      // The network heals. Nothing else about either node has changed.
      offline.delete(CORE_FQDN);
      offline.delete(BETA_FQDN);
      await core.poll();
      await beta.poll();

      expect(core.repo.only()).toMatchObject({ status: 'connected', consecutiveFailures: 0 });
      expect(beta.repo.only()).toMatchObject({ status: 'connected', consecutiveFailures: 0 });
    });

    /** The recovering probe must come back with a real inventory, not merely a 200. */
    it('re-caches the peer inventory after a mutual outage, so routing resumes', async () => {
      await pairNodes();
      offline.add(CORE_FQDN);
      offline.add(BETA_FQDN);
      for (let i = 0; i < 3; i += 1) {
        await core.poll();
        await beta.poll();
      }

      offline.delete(CORE_FQDN);
      offline.delete(BETA_FQDN);
      await core.poll();

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

  describe('container counts across the wire', () => {
    /** What `refreshOnePeer` cached about the other node on its last poll. */
    function cachedOn(node: Node): PoolPeerCapabilities {
      return node.repo.only().lastCapabilities as unknown as PoolPeerCapabilities;
    }

    const rollup: PoolContainerRollup = { running: 6, stopped: 2, total: 8, cpuPercent: 91.25, memoryBytes: 5_368_709_120 };

    it('carries core’s rollup through /capabilities into beta’s cached snapshot and status card', async () => {
      await pairNodes();
      core.setContainerSample(rollup);

      await beta.poll();
      const status = await beta.service.getPoolStatus();

      // No new route and no migration: it rides the existing authenticated capabilities probe into
      // the `last_capabilities` jsonb that is already there.
      expect(cachedOn(beta).containers).toEqual(rollup);
      expect(status.peers[0]?.containers).toEqual(rollup);
    });

    it('leaves the key off the wire entirely when core’s operator opted out', async () => {
      await pairNodes();
      core.setContainerSample(rollup);
      core.setShareContainerStats(false);

      await beta.poll();
      const status = await beta.service.getPoolStatus();

      // Indistinguishable from a peer on an older build, and that is the point: both mean "we
      // cannot tell you". Neither may ever surface as an idle machine.
      expect(cachedOn(beta)).not.toHaveProperty('containers');
      expect(status.peers[0]?.containers).toBeNull();
      // And the rest of the payload is untouched — opting out of one disclosure is not leaving the pool.
      expect(cachedOn(beta).backends[0]?.modelsLoaded).toContain(SHARED_MODEL);
      expect(beta.repo.only()).toMatchObject({ status: 'connected' });
    });

    it('leaves the key off the wire when core’s monitor has collected nothing', async () => {
      await pairNodes();
      core.setContainerSample(null);

      await beta.poll();

      expect(cachedOn(beta)).not.toHaveProperty('containers');
    });

    it('keeps core’s counts honest while core refuses inbound work', async () => {
      await pairNodes();
      core.setContainerSample(rollup);
      core.setInboundEnabled(false);

      await beta.poll();

      // The refusal empties the model inventory, which is the OFFER. The container figures are a
      // health signal about a machine that is still very much running, and blanking them would
      // draw a loaded box as an idle one at the moment an operator went looking.
      expect(cachedOn(beta)).toMatchObject({ acceptingWork: false, containers: rollup });
      expect(cachedOn(beta).backends).toEqual([]);
    });

    it('drops a hostile rollup on the read path, however it got into the column', async () => {
      await pairNodes();
      // Written straight into the jsonb, as a peer running anything at all could arrange: the probe
      // that stores this does not validate, by design, so the clamp has to be on the read.
      await beta.repo.update(beta.repo.only().id, {
        lastCapabilities: { hardwareTier: 'high', backends: [], containers: { running: -1, stopped: 0, total: 0, cpuPercent: 0, memoryBytes: 0 } },
        lastSeenAt: new Date().toISOString(),
      } as never);

      const status = await beta.service.getPoolStatus();

      expect(status.peers[0]?.containers).toBeNull();
    });
  });

  /**
   * One id for one call, on both nodes. Fleet QA attributed an agent turn's calls to rows by time
   * window on the entry Hub's clock, which cannot tell two concurrent calls for one model apart and
   * cannot see the serving node's row at all. Driven through REAL proxies on both sides — core's
   * ranking and forward, beta's guard, controller and inbound recording — with only the two engines
   * faked, because the claim is about what crosses the wire: a single-node test would only prove that
   * each side writes an id, not that they write the same one.
   */
  describe('request ids across the wire', () => {
    const CORE_ENGINE = 'core-engine.test';
    const BETA_ENGINE = 'beta-engine.test';

    let coreLog: HubPoolRoutingLogService;
    let betaLog: HubPoolRoutingLogService;
    let coreProxy: PoolProxyService;
    let betaController: HubPoolController;
    /** Bodies beta's engine received, to prove the work really ran there. */
    let betaEngineCalls: string[];

    /** Ollama present and serving `models` at `host`; the other five engines absent. */
    function registryServing(host: string, models: string[]): InferenceBackendRegistry {
      const engine = (running: boolean) => {
        const backend = mock<OllamaBackend>();
        backend.healthCheck.mockResolvedValue({ running, healthy: running, modelsLoaded: running ? models : [] });
        backend.getBaseUrl.mockReturnValue(`http://${host}`);
        return backend as never;
      };
      return new InferenceBackendRegistry(engine(true), engine(false), engine(false), engine(false), engine(false), engine(false));
    }

    function realProxy(node: Node, registry: InferenceBackendRegistry, log: HubPoolRoutingLogService): PoolProxyService {
      const pressure = mock<HubPoolPressureService>();
      pressure.band.mockReturnValue(null);
      return new PoolProxyService(registry, node.service, mock<TailscaleService>(), new HubPoolLoadService(), node.configuration, log, pressure);
    }

    /** The subset of an Express response the proxy writes to: status, headers, and a real stream for the body. */
    function capturingResponse() {
      const chunks: Buffer[] = [];
      const headers: Record<string, string> = {};
      let statusCode = 200;
      const res = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          callback();
        },
      }) as unknown as import('express').Response;
      res.status = ((code: number) => {
        statusCode = code;
        return res;
      }) as never;
      res.setHeader = ((name: string, value: string) => {
        headers[name.toLowerCase()] = String(value);
        return res;
      }) as never;
      res.json = ((payload: unknown) => {
        chunks.push(Buffer.from(JSON.stringify(payload)));
        res.end();
        return res;
      }) as never;
      return { res, headers, status: () => statusCode, body: () => Buffer.concat(chunks).toString() };
    }

    beforeEach(() => {
      coreLog = new HubPoolRoutingLogService();
      betaLog = new HubPoolRoutingLogService();
      // Core has the shared model only, so a request for beta's model has exactly one candidate: beta.
      coreProxy = realProxy(core, registryServing(CORE_ENGINE, [SHARED_MODEL]), coreLog);
      const betaProxy = realProxy(beta, registryServing(BETA_ENGINE, [SHARED_MODEL, BETA_ONLY_MODEL]), betaLog);
      betaController = new HubPoolController(
        beta.service,
        betaProxy,
        mock<TailscaleService>(),
        beta.configuration,
        betaLog,
        new HubPoolDiscoveryService(mock<LoggerService>(), beta.service),
        mock<HubPoolPinService>(),
      );
      betaEngineCalls = [];

      // Layered over the pairing router: beta's engine, and beta's `local/*` route through its real
      // guard and the real-proxy controller above. Everything else goes to the router as before.
      const router = global.fetch;
      global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        if (url.host === BETA_ENGINE) {
          betaEngineCalls.push(String(init?.body ?? ''));
          return new Response(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.hostname === BETA_FQDN && url.pathname === '/api/inference/pool/local/api/chat') {
          const request = {
            header: headerLookup(init),
            poolPeer: undefined,
            method: (init?.method ?? 'GET').toUpperCase(),
            originalUrl: url.pathname,
            url: url.pathname,
            path: url.pathname,
            body: init?.body ? JSON.parse(init.body as string) : {},
            ip: '100.64.0.9',
          } as unknown as Request;
          await beta.guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) } as never);
          const captured = capturingResponse();
          await betaController.localOllamaChat(request, request.body as Record<string, unknown>, captured.res);
          return new Response(captured.body(), { status: captured.status(), headers: captured.headers });
        }
        return router(input, init);
      }) as typeof fetch;
    });

    async function routeFromCore(content: string) {
      const captured = capturingResponse();
      await coreProxy.proxyRequest({
        path: '/api/chat',
        method: 'POST',
        body: { model: BETA_ONLY_MODEL, messages: [{ role: 'user', content }] },
        model: BETA_ONLY_MODEL,
        res: captured.res,
      });
      return captured;
    }

    it('puts the same id on core’s response, core’s outbound row and beta’s inbound row', async () => {
      await pairNodes();
      await core.poll();

      const response = await routeFromCore('hello');

      expect(response.status()).toBe(200);
      expect(response.headers[POOL_SERVED_BY_HEADER.toLowerCase()]).toBe(BETA_FQDN);
      expect(betaEngineCalls).toHaveLength(1);
      const id = response.headers[POOL_REQUEST_ID_HEADER.toLowerCase()];
      expect(id).toMatch(/^[0-9a-f-]{36}$/);

      const outbound = coreLog.list()[0];
      const inbound = betaLog.list()[0];
      expect(outbound).toMatchObject({ id, direction: 'outbound', node: BETA_FQDN, outcome: 'served' });
      expect(inbound).toMatchObject({ id, direction: 'inbound', node: CORE_FQDN, outcome: 'served' });
      // Both sides describe the same body, so a budget read on one node means the same thing on the other.
      expect(inbound?.bodyBytes).toBe(outbound?.bodyBytes);
      expect(inbound).toMatchObject({ stream: false, budgetMs: outbound?.budgetMs });
    });

    it('tells two concurrent calls for the same model apart, which a time window could not', async () => {
      await pairNodes();
      await core.poll();

      const [first, second] = await Promise.all([routeFromCore('one'), routeFromCore('two')]);

      const responseIds = [first.headers['x-hub-pool-request-id'], second.headers['x-hub-pool-request-id']];
      expect(new Set(responseIds).size).toBe(2);
      expect(new Set(coreLog.list().map((row) => row.id))).toEqual(new Set(responseIds));
      expect(new Set(betaLog.list().map((row) => row.id))).toEqual(new Set(responseIds));
    });

    /**
     * The one-poll window `forwardLocal` documents: core still holds a snapshot saying beta serves,
     * and beta has switched inbound off since. Beta's refusal row is the other half of core's failure,
     * and the caller's 502 carries the id that finds both.
     */
    it('joins a refusal on beta to the failed row on core, and hands the caller that id on the 502', async () => {
      await pairNodes();
      await core.poll();
      beta.setInboundEnabled(false);

      const response = await routeFromCore('refused');

      expect(response.status()).toBe(502);
      const id = response.headers['x-hub-pool-request-id'];
      expect(id).toBeTruthy();
      expect(response.headers).not.toHaveProperty('x-hub-pool-served-by');
      expect(coreLog.list()[0]).toMatchObject({ id, outcome: 'failed', failedOverFrom: [BETA_FQDN] });
      expect(betaLog.list()[0]).toMatchObject({ id, direction: 'inbound', outcome: 'failed', status: 503 });
      expect(betaEngineCalls).toHaveLength(0);
    });
  });

  /**
   * The ceiling's whole path, across the real wire: core's operator sets it, core's `/capabilities`
   * carries it, beta's health poll caches it, and beta's own proxy — the ENTRY node — reads it back
   * out of that cache to decide where a long prompt goes. core stands in for fzzy here.
   */
  describe('prompt ceiling across the wire', () => {
    const LONG_PROMPT_BYTES = 184_000; // ~46k tokens, the turn fzzy could not start in 922 s

    function cachedOn(node: Node): PoolPeerCapabilities {
      return node.repo.only().lastCapabilities as unknown as PoolPeerCapabilities;
    }

    /** Beta's real proxy over beta's real peer service, with beta's own engine holding the shared model. */
    function proxyOn(node: Node): PoolProxyService {
      const ollama = mock<OllamaBackend>();
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [SHARED_MODEL] });
      const others = [mock<VllmBackend>(), mock<LemonadeBackend>(), mock<MtplxBackend>(), mock<DsparkBackend>(), mock<LuceboxBackend>()];
      for (const backend of others) {
        backend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
      }
      const [vllm, lemonade, mtplx, dspark, lucebox] = others as [VllmBackend, LemonadeBackend, MtplxBackend, DsparkBackend, LuceboxBackend];
      const pressure = mock<HubPoolPressureService>();
      pressure.band.mockReturnValue(null);
      const loadService = new HubPoolLoadService();
      // Two requests queued here, so the ranker alone would hand the next one to idle core.
      loadService.acquire('local');
      loadService.acquire('local');
      return new PoolProxyService(
        new InferenceBackendRegistry(ollama, vllm, lemonade, mtplx, dspark, lucebox),
        node.service,
        mock<TailscaleService>(),
        loadService,
        node.configuration,
        new HubPoolRoutingLogService(),
        pressure,
      );
    }

    it('carries core’s ceiling through /capabilities into beta’s cached snapshot and status card', async () => {
      await pairNodes();
      core.setMaxPromptTokens(16_000);

      await beta.poll();

      expect(cachedOn(beta).maxPromptTokens).toBe(16_000);
      expect((await beta.service.getPoolStatus()).peers[0]?.maxPromptTokens).toBe(16_000);
      expect((await core.service.getPoolStatus()).localNode).toMatchObject({ maxPromptTokens: 16_000, maxPromptTokensSetBy: 'setting' });
    });

    it('leaves the key off the wire when core has no ceiling, and takes it off again when one is cleared', async () => {
      await pairNodes();
      await beta.poll();
      expect(cachedOn(beta)).not.toHaveProperty('maxPromptTokens');

      core.setMaxPromptTokens(16_000);
      await beta.poll();
      core.setMaxPromptTokens(null);
      await beta.poll();

      expect(cachedOn(beta)).not.toHaveProperty('maxPromptTokens');
      expect((await beta.service.getPoolStatus()).peers[0]?.maxPromptTokens).toBeNull();
    });

    it('makes beta route a long prompt away from core, and only a long one', async () => {
      await pairNodes();
      core.setMaxPromptTokens(16_000);
      await beta.poll();
      const proxy = proxyOn(beta);
      const coreRowId = beta.repo.only().id;

      expect((await proxy.buildCandidateList(SHARED_MODEL, 4_000)).map((candidate) => candidate.peerId)).toEqual([coreRowId, null]);
      expect((await proxy.buildCandidateList(SHARED_MODEL, LONG_PROMPT_BYTES)).map((candidate) => candidate.peerId)).toEqual([null, coreRowId]);
    });
  });
  /**
   * Throughput's whole path, across the real wire: core's own engine is timed missing a deadline (core
   * stands in for fzzy), core's `/capabilities` advertises it, beta's health poll caches it, and beta's
   * proxy — which never sent core a long prompt itself — reads it back to place one.
   */
  describe('throughput across the wire', () => {
    const LONG_PROMPT_BYTES = 184_000; // ~46k tokens

    function proxyOn(node: Node): PoolProxyService {
      const ollama = mock<OllamaBackend>();
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [SHARED_MODEL] });
      const others = [mock<VllmBackend>(), mock<LemonadeBackend>(), mock<MtplxBackend>(), mock<DsparkBackend>(), mock<LuceboxBackend>()];
      for (const backend of others) {
        backend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
      }
      const [vllm, lemonade, mtplx, dspark, lucebox] = others as [VllmBackend, LemonadeBackend, MtplxBackend, DsparkBackend, LuceboxBackend];
      const pressure = mock<HubPoolPressureService>();
      pressure.band.mockReturnValue(null);
      const loadService = new HubPoolLoadService();
      // Two requests queued here, so the ranker alone would hand the next one to idle core.
      loadService.acquire('local');
      loadService.acquire('local');
      return new PoolProxyService(
        new InferenceBackendRegistry(ollama, vllm, lemonade, mtplx, dspark, lucebox),
        node.service,
        mock<TailscaleService>(),
        loadService,
        node.configuration,
        new HubPoolRoutingLogService(),
        pressure,
        // One `undefined` (the model registry) and then the throughput slot: the two `undefined`s
        // this used to pass landed `node.throughput` on the router's slot instead, and the proxy
        // quietly built a store of its own. The local-health slot after it is left to its default.
        undefined,
        node.throughput,
      );
    }

    it("carries core's own missed deadline into beta's snapshot and status card, and beta places a long prompt on it", async () => {
      await pairNodes();
      core.throughput.recordPrefill(
        { nodeKey: 'local', backend: 'ollama', model: SHARED_MODEL },
        { promptTokens: 46_000, ms: 922_000, deadline: true },
      );

      await beta.poll();

      const cached = beta.repo.only().lastCapabilities as unknown as PoolPeerCapabilities;
      expect(cached.throughput).toEqual([expect.objectContaining({ model: SHARED_MODEL, backend: 'ollama' })]);
      expect((await beta.service.getPoolStatus()).peers[0]?.throughput).toMatchObject({
        observed: [],
        advertised: [{ model: SHARED_MODEL, prefill: [{ fromTokens: 32_768, deadline: true }] }],
      });
      const proxy = proxyOn(beta);
      const coreRowId = beta.repo.only().id;
      expect((await proxy.buildCandidateList(SHARED_MODEL, 40_000)).map((candidate) => candidate.peerId)).toEqual([coreRowId, null]);
      expect((await proxy.buildCandidateList(SHARED_MODEL, LONG_PROMPT_BYTES)).map((candidate) => candidate.peerId)).toEqual([null, coreRowId]);
    });

    it('leaves the key off the wire until core has timed something', async () => {
      await pairNodes();

      await beta.poll();

      expect(beta.repo.only().lastCapabilities).not.toHaveProperty('throughput');
      expect((await beta.service.getPoolStatus()).peers[0]?.throughput).toEqual({ observed: [], advertised: [] });
    });
  });
});
