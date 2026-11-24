import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { BadGatewayException, ConflictException, HttpStatus, type INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { json, type NextFunction, type Request, type Response } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { DATA_DIR } from '@/common/constants';
import { MainExceptionFilter } from '@/common/error/exception.filter';
import { TranslatableError } from '@/common/error/translatable-error';
import { DEFAULT_BODY_LIMIT } from '@/common/helpers/body-limits';
import {
  DEFAULT_POOL_HEALTH_POLL_SECONDS,
  DEFAULT_POOL_LOCAL_AFFINITY,
  describeHubPoolInboundRefused,
  type HubPoolPreferences,
} from '@/common/helpers/hub-pool';
import { ZodValidationPipe } from '@/common/zod-dto';
import { ConfigurationService } from '@/core/config/configuration.service';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import type { EncryptionService } from '@/core/encryption/encryption.service';
import { LoggerService } from '@/core/logger/logger.service';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import type { InferenceRouterService } from '@/modules/inference/inference-router.service';
import type { HubPoolIdentityRepository, HubPoolIdentityRow } from '@/modules/hub-pool/hub-pool-identity.repository';
import { HubPoolIdentityService, type LoadedPoolIdentity } from '@/modules/hub-pool/hub-pool-identity.service';
import { HubPoolLoadService } from '@/modules/hub-pool/hub-pool-load.service';
import type { HubPoolPairingPinService } from '@/modules/hub-pool/hub-pool-pairing-pin.service';
import { HubPoolPeerRepository } from '@/modules/hub-pool/hub-pool-peer.repository';
import { HubPoolPeerService } from '@/modules/hub-pool/hub-pool-peer.service';
import type { HubPoolPressureService } from '@/modules/hub-pool/hub-pool-pressure.service';
import type { TailscaleAdminApiService } from '@/modules/tailscale/tailscale-admin-api.service';
import type { TailscaleService } from '@/modules/tailscale/tailscale.service';
import type { UserDto } from '@/modules/user/dto/user.dto';
import { TrainingController } from '../training.controller';
import { TrainingGovernorService } from '../training-governor.service';
import { TrainingPoolService } from '../training-pool.service';
import { TrainingRunnerService } from '../training-runner.service';
import type { TrainingJobManifest, TrainingPeerCapability } from '../training.types';

/**
 * Real HTTP dispatch, for the reason `hub-pool-ollama-compat.controller.test.ts` gives: calling a
 * handler directly proves nothing about the guards Nest runs in front of it, and the guards are what
 * this suite is about.
 *
 * Three Hubs in one process. Beta is the node under test: the real `TrainingController` behind the real
 * `AuthGuard`, `HubManagerGuard` and `PoolPeerGuard`, served by Nest with the Hub's global prefix,
 * pipe and filter. Alpha sends work to beta: a real `HubPoolPeerService` and `TrainingPoolService`,
 * whose `fetch` to beta's MagicDNS name is routed to beta's port, and its own `TrainingController`,
 * served the same way, so the offload tests can read what alpha's operator is told. Gamma is a second
 * peer of beta's, and only signs requests. Each pair holds each other's peer row and pool identity, so
 * beta's guard checks a peer's signature exactly as it would across the tailnet.
 *
 * Beta's runner is real, but its governor never answers, so a job it accepts waits for resources for
 * the life of the file: nothing is written to disk and no trainer is started. Alpha's runner is a mock,
 * and its governor always reports no room, so alpha's operator routes always look for a peer.
 *
 * The disk is the in-memory one `vite.setup.ts` empties before every test, with `DATA_DIR` at `/data`.
 * Each test starts with {@link DATASET} staged in the training data directory, where a peer may point.
 */

const ALPHA_FQDN = 'hub-a.example-tailnet.ts.net';
const BETA_FQDN = 'hub-b.example-tailnet.ts.net';
const GAMMA_FQDN = 'hub-c.example-tailnet.ts.net';
/** The pairing token beta issued alpha: what alpha presents on the bearer path, and what beta keeps the hash of. */
const ALPHA_BEARER = 'b'.repeat(64);
/** The pairing token beta issued gamma. */
const GAMMA_BEARER = 'c'.repeat(64);

/** The fetch the suite itself uses. Alpha's is replaced in the offload tests; this one never is. */
const realFetch = globalThis.fetch;

/** The only folder a peer's manifest may name. */
const TRAINING_DATA_DIR = path.join(DATA_DIR, 'training');
/** The dataset every manifest names unless a test says otherwise, staged before each test. */
const DATASET = path.join(TRAINING_DATA_DIR, 'hbpe', 'tokens.jsonl');

function manifest(jobId: string, overrides: Partial<TrainingJobManifest> = {}): TrainingJobManifest {
  return {
    jobId,
    appId: 'ci-memory',
    jobType: 'hbpe_nightly_lora',
    model: { backboneId: 'ci/hmt-v1', framework: 'pytorch', targetFormat: 'pytorch_lora' },
    dataset: { format: 'token_stream_jsonl', dataPath: DATASET, valFraction: 0.15 },
    hyperparameters: { batchSize: 16, learningRate: 1e-4, epochs: 4, mixedPrecision: true },
    resourcePolicy: { devicePreference: 'auto', allowRemoteOffload: false, priority: 'nightly_idle', timeoutSeconds: 3600 },
    ...overrides,
  };
}

function peerRow(overrides: Partial<HubPoolPeer>): HubPoolPeer {
  const now = new Date().toISOString();
  return {
    id: 'peer',
    tailscaleDeviceId: null,
    nodeFqdn: 'unset.example-tailnet.ts.net',
    displayName: null,
    direction: 'outbound',
    status: 'connected',
    enabled: true,
    consecutiveFailures: 0,
    lastSeenAt: now,
    lastCapabilities: null,
    verifyTokenHash: null,
    presentTokenEncrypted: null,
    peerNodeUuid: null,
    peerPublicKey: null,
    bearerGraceUntil: null,
    signedSeenAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Salted the way production salts it, so a token decrypted against the wrong salt fails visibly. */
function fakeEncryption(): MockProxy<EncryptionService> {
  const encryption = mock<EncryptionService>();
  encryption.encrypt.mockImplementation((data: string, salt: string) => `ENC(${salt}):${data}`);
  encryption.decrypt.mockImplementation((data: string, salt: string) => {
    const prefix = `ENC(${salt}):`;
    if (!data.startsWith(prefix)) {
      throw new Error(`encrypted with a different salt than ${salt}`);
    }
    return data.slice(prefix.length);
  });
  return encryption;
}

/** The one-row `hub_pool_identity` table, so the real identity service mints and keeps a key. */
function fakeIdentityRepository(): HubPoolIdentityRepository {
  let row: HubPoolIdentityRow | undefined;
  return {
    get: async () => row,
    insertIfAbsent: async (values: Omit<HubPoolIdentityRow, 'id' | 'createdAt' | 'rotatedAt'>) => {
      row ??= { id: 'self', createdAt: new Date().toISOString(), rotatedAt: null, ...values };
    },
  } as unknown as HubPoolIdentityRepository;
}

function defaultPreferences(): HubPoolPreferences {
  return {
    poolEnabled: true,
    poolOutboundEnabled: true,
    poolInboundEnabled: true,
    poolLocalAffinity: DEFAULT_POOL_LOCAL_AFFINITY,
    poolHealthPollSeconds: DEFAULT_POOL_HEALTH_POLL_SECONDS,
    poolPins: [],
    poolRequireSignedPeers: false,
  };
}

/** One Hub's pool: its `hub_pool_peer` rows, its identity, its settings and a real `HubPoolPeerService` over them. */
interface Hub {
  fqdn: string;
  rows: Map<string, HubPoolPeer>;
  repo: MockProxy<HubPoolPeerRepository>;
  identity: HubPoolIdentityService;
  configuration: MockProxy<ConfigurationService>;
  preferences: HubPoolPreferences;
  peerService: HubPoolPeerService;
}

function buildHub(fqdn: string): Hub {
  const rows = new Map<string, HubPoolPeer>();
  const repo = mock<HubPoolPeerRepository>();
  repo.findById.mockImplementation(async (id) => rows.get(id));
  repo.findByNodeFqdn.mockImplementation(async (nodeFqdn) => [...rows.values()].find((row) => row.nodeFqdn === nodeFqdn));
  repo.findByNodeUuid.mockImplementation(async (uuid) => [...rows.values()].find((row) => row.peerNodeUuid === uuid));
  repo.listByStatus.mockImplementation(async (status) => [...rows.values()].filter((row) => row.status === status));
  repo.update.mockImplementation(async (id, data) => {
    const existing = rows.get(id);
    if (!existing) {
      return undefined;
    }
    const next: HubPoolPeer = { ...existing, ...(data as Partial<HubPoolPeer>) };
    rows.set(id, next);
    return next;
  });

  const hub = { fqdn, rows, repo, preferences: defaultPreferences() } as Hub;
  hub.configuration = mock<ConfigurationService>();
  // Read through `hub.preferences` on every call, so a test changes a setting by assigning to it.
  hub.configuration.getHubPoolPreferences.mockImplementation(() => ({ ...hub.preferences }));

  const encryption = fakeEncryption();
  hub.identity = new HubPoolIdentityService(mock<LoggerService>(), fakeIdentityRepository(), encryption);
  const tailscale = mock<TailscaleService>();
  tailscale.getStatusCached.mockResolvedValue({ nodeFqdn: fqdn } as Awaited<ReturnType<TailscaleService['getStatusCached']>>);
  hub.peerService = new HubPoolPeerService(
    mock<LoggerService>(),
    repo,
    tailscale,
    mock<TailscaleAdminApiService>(),
    encryption,
    mock<InferenceRouterService>(),
    new HubPoolLoadService(),
    hub.configuration,
    hub.identity,
    mock<HubPoolPairingPinService>(),
    mock<HubPoolPressureService>(),
  );
  return hub;
}

async function identityOf(hub: Hub): Promise<LoadedPoolIdentity> {
  const identity = await hub.identity.get();
  if (!identity) {
    throw new Error(`${hub.fqdn} could not mint a pool identity`);
  }
  return identity;
}

/**
 * Stands in for `AuthMiddleware`, which is what sets `req.user` in the running Hub. `x-test-user`
 * names one of these users; without it the request is anonymous, like one with no session or key.
 */
const USERS: Record<string, UserDto> = {
  operator: {
    id: 1,
    username: 'operator',
    totpEnabled: false,
    locale: 'en',
    operator: true,
    hasCompletedOnboarding: true,
    advancedMode: false,
    orgRole: 'owner',
  },
  member: {
    id: 2,
    username: 'member',
    totpEnabled: false,
    locale: 'en',
    operator: false,
    hasCompletedOnboarding: true,
    advancedMode: false,
    orgRole: 'member',
  },
};

function signedInFromHeader(req: Request, _res: Response, next: NextFunction): void {
  const user = USERS[req.header('x-test-user') ?? ''];
  if (user) {
    req.user = user;
  }
  next();
}

/** The services one Hub's `TrainingController` is built from. */
interface TrainingServices {
  runner: TrainingRunnerService;
  pool: TrainingPoolService;
  governor: TrainingGovernorService;
}

/** Serves `hub`'s `TrainingController` behind the real guards, the way the running Hub does. */
async function serveTraining(
  hub: Hub,
  services: TrainingServices,
  whois: MarketplaceWhoIsService,
): Promise<{ app: INestApplication; baseUrl: string }> {
  const moduleRef = await Test.createTestingModule({
    controllers: [TrainingController],
    providers: [
      { provide: TrainingRunnerService, useValue: services.runner },
      { provide: TrainingPoolService, useValue: services.pool },
      { provide: TrainingGovernorService, useValue: services.governor },
      { provide: HubPoolPeerService, useValue: hub.peerService },
      // What Nest builds `PoolPeerGuard` from, as it does inside HubPoolModule.
      { provide: HubPoolPeerRepository, useValue: hub.repo },
      { provide: HubPoolIdentityService, useValue: hub.identity },
      { provide: ConfigurationService, useValue: hub.configuration },
      { provide: LoggerService, useValue: mock<LoggerService>() },
      { provide: MarketplaceWhoIsService, useValue: whois },
      // The pipe and filter app.module.ts registers for every route.
      { provide: APP_PIPE, useClass: ZodValidationPipe },
      { provide: APP_FILTER, useFactory: (log: LoggerService) => new MainExceptionFilter(log), inject: [LoggerService] },
    ],
  }).compile();

  const app = moduleRef.createNestApplication({ bodyParser: false });
  // As main.ts does: every route lives under /api, and bodies are parsed with the default limit.
  app.setGlobalPrefix('/api');
  app.use(json({ limit: DEFAULT_BODY_LIMIT }));
  app.use(signedInFromHeader);
  await app.listen(0, '127.0.0.1');
  return { app, baseUrl: `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}` };
}

describe('TrainingController — real HTTP dispatch through the guards', () => {
  let alpha: Hub;
  let beta: Hub;
  let gamma: Hub;
  let app: INestApplication;
  let betaBaseUrl: string;
  let alphaApp: INestApplication;
  let alphaBaseUrl: string;
  let governor: MockProxy<TrainingGovernorService>;
  let runner: TrainingRunnerService;
  let pool: TrainingPoolService;
  let alphaPool: TrainingPoolService;
  let submitJob: MockInstance<TrainingRunnerService['submitJob']>;
  let cancelJob: MockInstance<TrainingRunnerService['cancelJob']>;
  let listJobs: MockInstance<TrainingRunnerService['listJobs']>;
  let discoverPeers: MockInstance<TrainingPoolService['discoverTrainingPeers']>;
  let jobNumber = 0;

  /** A job id no earlier test has used: beta's jobs stay in flight for the life of the file. */
  const nextJobId = () => `job-${++jobNumber}`;

  beforeAll(async () => {
    alpha = buildHub(ALPHA_FQDN);
    beta = buildHub(BETA_FQDN);
    gamma = buildHub(GAMMA_FQDN);

    governor = mock<TrainingGovernorService>();
    // Never settles, so every job beta accepts stays in flight (see the file comment).
    governor.evaluateLocalCapacity.mockReturnValue(new Promise(() => {}));
    governor.getEstimatedAvailableVramMb.mockResolvedValue(24_576);
    runner = new TrainingRunnerService(governor);
    pool = new TrainingPoolService(beta.peerService, runner, governor);

    const alphaRunner = mock<TrainingRunnerService>();
    const alphaGovernor = mock<TrainingGovernorService>();
    alphaGovernor.evaluateLocalCapacity.mockResolvedValue({ canExecuteLocal: false, recommendedAction: 'OFFLOAD', reason: 'no room on alpha' });
    alphaPool = new TrainingPoolService(alpha.peerService, alphaRunner, alphaGovernor);

    submitJob = vi.spyOn(runner, 'submitJob');
    cancelJob = vi.spyOn(runner, 'cancelJob');
    listJobs = vi.spyOn(runner, 'listJobs');
    discoverPeers = vi.spyOn(pool, 'discoverTrainingPeers');

    // `HubManagerGuard` asks the WhoIs service. Here only the operator may manage the Hub.
    const whois = mock<MarketplaceWhoIsService>();
    whois.assertSessionMayManageHub.mockImplementation(async (req) => {
      if (!req.user?.operator) {
        throw new TranslatableError('HUB_MANAGE_ROLE_REQUIRED', {}, HttpStatus.FORBIDDEN);
      }
    });

    ({ app, baseUrl: betaBaseUrl } = await serveTraining(beta, { runner, pool, governor }, whois));
    ({ app: alphaApp, baseUrl: alphaBaseUrl } = await serveTraining(alpha, { runner: alphaRunner, pool: alphaPool, governor: alphaGovernor }, whois));
  }, 30_000);

  afterAll(async () => {
    await Promise.all([app?.close(), alphaApp?.close()]);
  });

  /**
   * A completed pairing between `peer` and beta, in both directions. Beta's row for the peer pins the
   * peer's key and keeps the hash of the token beta issued it; the peer's row for beta pins beta's key
   * and keeps that token, encrypted. Beta's other rows are kept.
   */
  async function pairWithBeta(
    peer: Hub,
    rowId: string,
    bearer: string,
    options: { onBeta?: Partial<HubPoolPeer>; onPeer?: Partial<HubPoolPeer> } = {},
  ): Promise<void> {
    const [peerIdentity, betaIdentity] = await Promise.all([identityOf(peer), identityOf(beta)]);
    beta.rows.set(
      rowId,
      peerRow({
        id: rowId,
        nodeFqdn: peer.fqdn,
        direction: 'inbound',
        peerNodeUuid: peerIdentity.nodeUuid,
        peerPublicKey: peerIdentity.publicKey,
        verifyTokenHash: createHash('sha256').update(bearer).digest('hex'),
        ...options.onBeta,
      }),
    );
    peer.rows.clear();
    peer.rows.set(
      'beta',
      peerRow({
        id: 'beta',
        nodeFqdn: BETA_FQDN,
        peerNodeUuid: betaIdentity.nodeUuid,
        peerPublicKey: betaIdentity.publicKey,
        presentTokenEncrypted: `ENC(${BETA_FQDN}):${bearer}`,
        ...options.onPeer,
      }),
    );
  }

  /** Beta paired with alpha alone. */
  async function pair(options: { onBeta?: Partial<HubPoolPeer>; onAlpha?: Partial<HubPoolPeer> } = {}): Promise<void> {
    beta.rows.clear();
    await pairWithBeta(alpha, 'alpha', ALPHA_BEARER, { onBeta: options.onBeta, onPeer: options.onAlpha });
  }

  beforeEach(async () => {
    fs.mkdirSync(path.dirname(DATASET), { recursive: true });
    fs.writeFileSync(DATASET, '');
    for (const hub of [alpha, beta, gamma]) {
      hub.preferences = defaultPreferences();
    }
    await pair();
    for (const spy of [submitJob, cancelJob, listJobs, discoverPeers]) {
      spy.mockClear();
    }
  });

  /** An operator-route request to the Hub served at `baseUrl`, as `user` (or as nobody). */
  function requestAs(
    baseUrl: string,
    user: keyof typeof USERS | null,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<globalThis.Response> {
    const headers: Record<string, string> = {};
    if (user) {
      headers['x-test-user'] = user;
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    return realFetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  /** An operator-route request to beta. */
  function asUser(user: keyof typeof USERS | null, method: 'GET' | 'POST', path: string, body?: unknown): Promise<globalThis.Response> {
    return requestAs(betaBaseUrl, user, method, path, body);
  }

  /** A peer-route request from `peer` to beta, carrying the credentials the peer's pool attaches to every peer call. */
  async function fromPeer(peer: Hub, method: 'GET' | 'POST', path: string, body?: unknown): Promise<globalThis.Response> {
    const row = peer.rows.get('beta');
    if (!row) {
      throw new Error(`${peer.fqdn} holds no row for beta`);
    }
    const auth = await peer.peerService.peerAuthHeaders(row, method, path, body);
    return realFetch(`${betaBaseUrl}${path}`, {
      method,
      headers: body === undefined ? auth : { ...auth, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function fromAlpha(method: 'GET' | 'POST', path: string, body?: unknown): Promise<globalThis.Response> {
    return fromPeer(alpha, method, path, body);
  }

  describe('operator routes', () => {
    beforeEach(() => {
      // Discovery dials real peers; what it reaches is covered from alpha's side below.
      discoverPeers.mockResolvedValue([]);
    });

    afterEach(() => {
      discoverPeers.mockReset();
    });

    it('refuses every operator route with 401 when nobody is signed in', async () => {
      const jobId = nextJobId();
      const routes: Array<['GET' | 'POST', string, unknown?]> = [
        ['POST', '/api/training/jobs', manifest(jobId)],
        ['GET', '/api/training/jobs'],
        ['GET', `/api/training/jobs/${jobId}`],
        ['POST', `/api/training/jobs/${jobId}/cancel`],
        ['GET', '/api/training/pool/peers'],
      ];

      for (const [method, path, body] of routes) {
        const res = await asUser(null, method, path, body);
        expect(res.status, `${method} ${path}`).toBe(401);
      }
      expect(submitJob).not.toHaveBeenCalled();
      expect(cancelJob).not.toHaveBeenCalled();
      expect(listJobs).not.toHaveBeenCalled();
      expect(discoverPeers).not.toHaveBeenCalled();
    });

    it('lets a signed-in member read training state, but not start or cancel a job', async () => {
      const jobId = nextJobId();

      expect((await asUser('member', 'GET', '/api/training/jobs')).status).toBe(200);
      // Past the guard: the job simply does not exist.
      expect((await asUser('member', 'GET', `/api/training/jobs/${jobId}`)).status).toBe(404);
      expect((await asUser('member', 'GET', '/api/training/pool/peers')).status).toBe(200);

      expect((await asUser('member', 'POST', '/api/training/jobs', manifest(jobId))).status).toBe(403);
      expect((await asUser('member', 'POST', `/api/training/jobs/${jobId}/cancel`)).status).toBe(403);
      expect(submitJob).not.toHaveBeenCalled();
      expect(cancelJob).not.toHaveBeenCalled();
    });

    it('lets a Hub manager submit, read and cancel a job', async () => {
      const jobId = nextJobId();

      const submitted = await asUser('operator', 'POST', '/api/training/jobs', manifest(jobId));
      expect(submitted.status).toBe(202);
      await expect(submitted.json()).resolves.toMatchObject({ jobId, executedOnNode: 'local' });

      const read = await asUser('operator', 'GET', `/api/training/jobs/${jobId}`);
      expect(read.status).toBe(200);
      await expect(read.json()).resolves.toMatchObject({ jobId });

      const cancelled = await asUser('operator', 'POST', `/api/training/jobs/${jobId}/cancel`);
      expect(cancelled.status).toBe(201);
      await expect(cancelled.json()).resolves.toEqual({ cancelled: true });
    });

    it('answers a malformed manifest with 400 before the runner sees it', async () => {
      const { resourcePolicy: _dropped, ...withoutResourcePolicy } = manifest(nextJobId());
      const bodies: unknown[] = [
        {},
        // Read before anything else on the old path, so its absence was a TypeError and a 500.
        withoutResourcePolicy,
        manifest('../outside-the-artifacts-dir'),
        manifest(nextJobId(), { jobType: 'not_a_job_type' as TrainingJobManifest['jobType'] }),
        manifest(nextJobId(), { hyperparameters: { batchSize: 16, learningRate: 1e-4, epochs: 0, mixedPrecision: true } }),
        manifest(nextJobId(), { hyperparameters: { batchSize: '16' as unknown as number, learningRate: 1e-4, epochs: 4, mixedPrecision: true } }),
        manifest(nextJobId(), { dataset: { format: 'token_stream_jsonl', dataPath: '/data/hbpe/tokens.jsonl', valFraction: 1 } }),
      ];

      for (const body of bodies) {
        const res = await asUser('operator', 'POST', '/api/training/jobs', body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect(submitJob).not.toHaveBeenCalled();
    });

    it('keeps the fields the trainer reads, including userId, and drops ones it does not know', async () => {
      const jobId = nextJobId();
      const userId = '7d1f3f52-3c39-4f3e-9b8e-0d7c5a8e2a11';

      const res = await asUser('operator', 'POST', '/api/training/jobs', { ...manifest(jobId), userId, unexpected: 'dropped' });

      expect(res.status).toBe(202);
      const received = submitJob.mock.calls[0]?.[0];
      expect(received).toMatchObject({ jobId, userId, hyperparameters: { epochs: 4 } });
      expect(received).not.toHaveProperty('unexpected');
    });

    it('refuses a job id that is already queued or running with 409', async () => {
      const jobId = nextJobId();
      const first = await asUser('operator', 'POST', '/api/training/jobs', manifest(jobId));
      expect(first.status).toBe(202);
      const firstStatus = runner.getJobStatus(jobId);

      const second = await asUser('operator', 'POST', '/api/training/jobs', manifest(jobId, { appId: 'someone-else' }));

      expect(second.status).toBe(409);
      expect(submitJob).toHaveBeenCalledTimes(1);
      // The first job's record was not replaced.
      expect(runner.getJobStatus(jobId)).toBe(firstStatus);
      expect(runner.getJobStatus(jobId)?.appId).toBe('ci-memory');
    });
  });

  describe('peer routes', () => {
    const peerRoutes = (jobId: string): Array<['GET' | 'POST', string, unknown?]> => [
      ['GET', '/api/training/pool/capabilities'],
      ['POST', '/api/training/pool/jobs', manifest(jobId)],
      ['GET', `/api/training/pool/jobs/${jobId}`],
    ];

    it('refuses a caller with no pool credentials with 401', async () => {
      for (const [method, path, body] of peerRoutes(nextJobId())) {
        const res = await asUser('operator', method, path, body);
        expect(res.status, `${method} ${path}`).toBe(401);
      }
      expect(submitJob).not.toHaveBeenCalled();
    });

    it('serves a connected, enabled peer', async () => {
      const jobId = nextJobId();

      const capabilities = await fromAlpha('GET', '/api/training/pool/capabilities');
      expect(capabilities.status).toBe(200);
      await expect(capabilities.json()).resolves.toMatchObject({ acceptingTrainingJobs: true, availableVramMb: 24_576 });

      expect((await fromAlpha('POST', '/api/training/pool/jobs', manifest(jobId))).status).toBe(202);
      const status = await fromAlpha('GET', `/api/training/pool/jobs/${jobId}`);
      expect(status.status).toBe(200);
      await expect(status.json()).resolves.toMatchObject({ jobId, executedOnNode: 'local' });
    });

    it('refuses with 403 a pairing the operator has not approved, though the guard admits it', async () => {
      await pair({ onBeta: { status: 'pending' } });

      for (const [method, path, body] of peerRoutes(nextJobId())) {
        const res = await fromAlpha(method, path, body);
        expect(res.status, `${method} ${path}`).toBe(403);
      }
      expect(submitJob).not.toHaveBeenCalled();
    });

    it('refuses with 503 a peer the operator disabled', async () => {
      await pair({ onBeta: { enabled: false } });

      for (const [method, path, body] of peerRoutes(nextJobId())) {
        const res = await fromAlpha(method, path, body);
        expect(res.status, `${method} ${path}`).toBe(503);
        await expect(res.json()).resolves.toMatchObject({ message: expect.stringContaining('the operator disabled this peer here') });
      }
      expect(submitJob).not.toHaveBeenCalled();
    });

    it('refuses every peer with 503 while inbound pooling is switched off', async () => {
      beta.preferences.poolInboundEnabled = false;

      for (const [method, path, body] of peerRoutes(nextJobId())) {
        const res = await fromAlpha(method, path, body);
        expect(res.status, `${method} ${path}`).toBe(503);
      }
      expect(submitJob).not.toHaveBeenCalled();
    });

    it('refuses every peer with 503 while the pool is switched off', async () => {
      beta.preferences.poolEnabled = false;

      for (const [method, path, body] of peerRoutes(nextJobId())) {
        const res = await fromAlpha(method, path, body);
        expect(res.status, `${method} ${path}`).toBe(503);
      }
      expect(submitJob).not.toHaveBeenCalled();
    });

    it("answers a job's status only to the peer that dispatched it", async () => {
      await pairWithBeta(gamma, 'gamma', GAMMA_BEARER);
      const [alphaJob, gammaJob, localJob, neverUsed] = [nextJobId(), nextJobId(), nextJobId(), nextJobId()];
      expect((await fromPeer(alpha, 'POST', '/api/training/pool/jobs', manifest(alphaJob))).status).toBe(202);
      expect((await fromPeer(gamma, 'POST', '/api/training/pool/jobs', manifest(gammaJob))).status).toBe(202);
      expect((await asUser('operator', 'POST', '/api/training/jobs', manifest(localJob))).status).toBe(202);

      for (const [peer, jobId] of [
        [alpha, alphaJob],
        [gamma, gammaJob],
      ] as const) {
        const res = await fromPeer(peer, 'GET', `/api/training/pool/jobs/${jobId}`);
        expect(res.status, `${peer.fqdn} reading ${jobId}`).toBe(200);
        await expect(res.json()).resolves.toMatchObject({ jobId });
      }

      // Another peer's job, and a local one, get the answer an id never used gets.
      for (const [peer, jobId] of [
        [alpha, gammaJob],
        [alpha, localJob],
        [gamma, alphaJob],
        [gamma, localJob],
        [alpha, neverUsed],
      ] as const) {
        const res = await fromPeer(peer, 'GET', `/api/training/pool/jobs/${jobId}`);
        expect(res.status, `${peer.fqdn} reading ${jobId}`).toBe(404);
        await expect(res.json()).resolves.toMatchObject({ message: `Training job ${jobId} not found` });
      }

      // Beta's own users still read every job.
      for (const jobId of [alphaJob, gammaJob, localJob]) {
        expect((await asUser('member', 'GET', `/api/training/jobs/${jobId}`)).status, jobId).toBe(200);
      }
    });

    it('stops answering a peer for its job id once a local job has taken the id', async () => {
      const jobId = nextJobId();
      // Beta defers this one job, so its lifecycle ends and the id can be used again.
      governor.evaluateLocalCapacity.mockResolvedValueOnce({ canExecuteLocal: false, recommendedAction: 'DEFER', reason: 'on battery' });
      expect((await fromAlpha('POST', '/api/training/pool/jobs', manifest(jobId))).status).toBe(202);
      await vi.waitFor(() => expect(runner.getJobStatus(jobId)?.state).toBe('DEFERRED'));
      expect((await fromAlpha('GET', `/api/training/pool/jobs/${jobId}`)).status).toBe(200);

      expect((await asUser('operator', 'POST', '/api/training/jobs', manifest(jobId))).status).toBe(202);

      expect((await fromAlpha('GET', `/api/training/pool/jobs/${jobId}`)).status).toBe(404);
      expect(runner.getJobStatus(jobId)?.state).not.toBe('DEFERRED');
    });

    describe('paths a peer names', () => {
      const REFUSED = (field: string) => `${field} must name an existing path in this Hub's training data directory`;

      /** A manifest naming `dataPath`, and `baseCheckpointPath` when given. */
      function naming(jobId: string, dataPath: string, baseCheckpointPath?: string): TrainingJobManifest {
        const base = manifest(jobId);
        return {
          ...base,
          model: baseCheckpointPath === undefined ? base.model : { ...base.model, baseCheckpointPath },
          dataset: { ...base.dataset, dataPath },
        };
      }

      it('takes paths that exist in the training data directory, through a link that stays inside it too', async () => {
        const checkpoint = path.join(TRAINING_DATA_DIR, 'checkpoints', 'base.pt');
        fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
        fs.writeFileSync(checkpoint, '');
        const linked = path.join(TRAINING_DATA_DIR, 'latest.jsonl');
        fs.symlinkSync(DATASET, linked);

        for (const body of [naming(nextJobId(), DATASET, checkpoint), naming(nextJobId(), linked), naming(nextJobId(), path.dirname(DATASET))]) {
          const res = await fromAlpha('POST', '/api/training/pool/jobs', body);
          expect(res.status, body.dataset.dataPath).toBe(202);
        }
      });

      it('refuses, with one 400, a path outside the training data directory, missing from it, or leading out of it', async () => {
        fs.symlinkSync(path.join(DATA_DIR, 'state', 'seed'), path.join(TRAINING_DATA_DIR, 'leads-out'));
        fs.mkdirSync(`${TRAINING_DATA_DIR}-x`, { recursive: true });
        fs.writeFileSync(path.join(`${TRAINING_DATA_DIR}-x`, 'tokens.jsonl'), '');
        const refused = [
          path.join(DATA_DIR, '.env'),
          path.join(DATA_DIR, 'state', 'seed'),
          path.join(DATA_DIR, 'no-such-file'),
          // Shares the folder's name as a prefix.
          path.join(`${TRAINING_DATA_DIR}-x`, 'tokens.jsonl'),
          // Climbs out once resolved.
          `${TRAINING_DATA_DIR}/../state/seed`,
          // Resolved against the working directory, as the runner resolves it.
          'hbpe/tokens.jsonl',
          path.join(TRAINING_DATA_DIR, 'missing.jsonl'),
          path.join(TRAINING_DATA_DIR, 'leads-out'),
        ];

        for (const refusedPath of refused) {
          const asDataset = await fromAlpha('POST', '/api/training/pool/jobs', naming(nextJobId(), refusedPath));
          expect(asDataset.status, refusedPath).toBe(400);
          await expect(asDataset.json()).resolves.toMatchObject({ message: REFUSED('dataset.dataPath') });

          const asCheckpoint = await fromAlpha('POST', '/api/training/pool/jobs', naming(nextJobId(), DATASET, refusedPath));
          expect(asCheckpoint.status, refusedPath).toBe(400);
          await expect(asCheckpoint.json()).resolves.toMatchObject({ message: REFUSED('model.baseCheckpointPath') });
        }
        expect(submitJob).not.toHaveBeenCalled();
      });

      it('refuses a path outside the training data directory without reading the disk', async () => {
        const realpath = vi.spyOn(fs.promises, 'realpath');
        try {
          const res = await fromAlpha('POST', '/api/training/pool/jobs', naming(nextJobId(), path.join(DATA_DIR, '.env')));

          expect(res.status).toBe(400);
          expect(realpath).not.toHaveBeenCalled();
        } finally {
          realpath.mockRestore();
        }
      });

      it('follows the training data directory itself when it is a link', async () => {
        const elsewhere = path.join('/srv', 'training-data');
        fs.rmSync(TRAINING_DATA_DIR, { recursive: true, force: true });
        fs.mkdirSync(path.join(elsewhere, 'hbpe'), { recursive: true });
        fs.writeFileSync(path.join(elsewhere, 'hbpe', 'tokens.jsonl'), '');
        fs.symlinkSync(elsewhere, TRAINING_DATA_DIR);

        expect((await fromAlpha('POST', '/api/training/pool/jobs', naming(nextJobId(), DATASET))).status).toBe(202);
      });

      it("leaves the operator's own route unrestricted", async () => {
        const res = await asUser('operator', 'POST', '/api/training/jobs', naming(nextJobId(), path.join(DATA_DIR, 'state', 'seed')));

        expect(res.status).toBe(202);
      });
    });
  });

  describe('offload from alpha', () => {
    let outbound: Array<{ url: string; headers: Headers }>;

    beforeEach(() => {
      outbound = [];
      // Alpha dials beta by MagicDNS name over HTTPS; here that lands on beta's test server instead.
      vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.hostname !== BETA_FQDN) {
          throw new Error(`alpha dialled ${url.hostname}, which is not paired in this test`);
        }
        outbound.push({ url: url.href, headers: new Headers(init?.headers) });
        return realFetch(`${betaBaseUrl}${url.pathname}`, init);
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('finds beta through a signed capabilities probe that beta accepts', async () => {
      const peers = await alphaPool.discoverTrainingPeers();

      expect(peers).toEqual([expect.objectContaining({ nodeFqdn: BETA_FQDN, acceptingTrainingJobs: true, availableVramMb: 24_576 })]);
      expect(outbound.map((request) => request.url)).toEqual([`https://${BETA_FQDN}/api/training/pool/capabilities`]);
    });

    it('dispatches a job with a signature over path and body that beta verifies', async () => {
      const jobId = nextJobId();

      const status = await alphaPool.dispatchJobToPeer(BETA_FQDN, manifest(jobId));

      expect(status).toMatchObject({ jobId, executedOnNode: BETA_FQDN });
      expect(runner.getJobStatus(jobId)).toBeDefined();
      const [sent] = outbound;
      expect(sent?.url).toBe(`https://${BETA_FQDN}/api/training/pool/jobs`);
      expect(sent?.headers.get('x-hub-pool-node')).toBe((await identityOf(alpha)).nodeUuid);
      expect(sent?.headers.get('x-hub-pool-peer')).toBe(ALPHA_FQDN);
      expect(sent?.headers.get('x-hub-pool-signature')).toMatch(/^v1\.ed25519\./);
      expect(sent?.headers.get('authorization')).toBeNull();
    });

    it('presents the decrypted pairing token, never the stored ciphertext, to a peer whose key is not pinned yet', async () => {
      await pair({ onAlpha: { peerNodeUuid: null, peerPublicKey: null }, onBeta: { peerNodeUuid: null, peerPublicKey: null } });
      const jobId = nextJobId();

      const status = await alphaPool.dispatchJobToPeer(BETA_FQDN, manifest(jobId));

      expect(status).toMatchObject({ jobId, executedOnNode: BETA_FQDN });
      const [sent] = outbound;
      expect(sent?.headers.get('authorization')).toBe(`Bearer ${ALPHA_BEARER}`);
      expect(sent?.headers.get('x-hub-pool-peer')).toBe(ALPHA_FQDN);
      expect(sent?.headers.get('x-hub-pool-signature')).toBeNull();
    });

    it('is turned away when beta has not approved the pairing', async () => {
      await pair({ onBeta: { status: 'pending' } });
      const jobId = nextJobId();

      await expect(alphaPool.discoverTrainingPeers()).resolves.toEqual([]);
      const refusal = await alphaPool.dispatchJobToPeer(BETA_FQDN, manifest(jobId)).catch((err: unknown) => err);
      expect(refusal).toBeInstanceOf(BadGatewayException);
      expect((refusal as Error).message).toBe(`Peer ${BETA_FQDN} refused training job ${jobId} with HTTP 403: Peer is not connected`);
      expect(submitJob).not.toHaveBeenCalled();
    });

    it('is turned away with 409 when beta already runs a job under that id', async () => {
      const jobId = nextJobId();
      await alphaPool.dispatchJobToPeer(BETA_FQDN, manifest(jobId));

      await expect(alphaPool.dispatchJobToPeer(BETA_FQDN, manifest(jobId))).rejects.toBeInstanceOf(ConflictException);
    });

    describe("what alpha's operator is told", () => {
      /** A job alpha's operator submits, which alpha's governor sends on to a peer (see the file comment). */
      function offloaded(jobId: string): TrainingJobManifest {
        const base = manifest(jobId);
        return { ...base, resourcePolicy: { ...base.resourcePolicy, allowRemoteOffload: true } };
      }

      function submitOnAlpha(jobId: string): Promise<globalThis.Response> {
        return requestAs(alphaBaseUrl, 'operator', 'POST', '/api/training/jobs', offloaded(jobId));
      }

      /** Beta, as alpha's discovery reported it before beta refused. */
      const betaAsDiscovered: TrainingPeerCapability = {
        nodeFqdn: BETA_FQDN,
        hardwareTier: 'High-end',
        acceptingTrainingJobs: true,
        availableVramMb: 24_576,
        gpuPressure: 0,
        supportedFrameworks: ['pytorch'],
        activeTrainingJobs: 0,
        lastUpdated: new Date().toISOString(),
      };

      it('gets the status back, naming beta, when beta takes the job', async () => {
        const jobId = nextJobId();

        const res = await submitOnAlpha(jobId);

        expect(res.status).toBe(202);
        await expect(res.json()).resolves.toMatchObject({ jobId, executedOnNode: BETA_FQDN });
        // Beta recorded the job against alpha, so alpha can read it back and nobody else can.
        expect(submitJob).toHaveBeenCalledWith(expect.objectContaining({ jobId }), 'alpha');
        expect((await fromAlpha('GET', `/api/training/pool/jobs/${jobId}`)).status).toBe(200);
      });

      it("gets beta's 409 passed through when beta already runs a job under that id", async () => {
        const jobId = nextJobId();
        expect((await fromAlpha('POST', '/api/training/pool/jobs', manifest(jobId))).status).toBe(202);

        const res = await submitOnAlpha(jobId);

        expect(res.status).toBe(409);
        await expect(res.json()).resolves.toMatchObject({ message: `Peer ${BETA_FQDN} already has training job ${jobId} queued or running` });
      });

      it("gets a 502 naming beta's status and reason when beta refuses the job", async () => {
        // Beta changes its answer between alpha's probe and alpha's dispatch, so alpha has already chosen it.
        const refusals: Array<{ refuse: () => Promise<void> | void; status: number; reason: string }> = [
          {
            refuse: () => {
              beta.preferences.poolInboundEnabled = false;
            },
            status: 503,
            reason: describeHubPoolInboundRefused('inbound_disabled'),
          },
          { refuse: () => pair({ onBeta: { status: 'pending' } }), status: 403, reason: 'Peer is not connected' },
        ];
        const select = vi.spyOn(alphaPool, 'selectOffloadPeer');

        try {
          for (const { refuse, status, reason } of refusals) {
            beta.preferences = defaultPreferences();
            await pair();
            await refuse();
            select.mockResolvedValueOnce(betaAsDiscovered);
            const jobId = nextJobId();

            const res = await submitOnAlpha(jobId);

            expect(res.status, reason).toBe(502);
            await expect(res.json()).resolves.toMatchObject({
              message: `Peer ${BETA_FQDN} refused training job ${jobId} with HTTP ${status}: ${reason}`,
            });
          }
        } finally {
          select.mockRestore();
        }
        expect(submitJob).not.toHaveBeenCalled();
      });

      it('gets a 502 when beta does not answer the dispatch at all', async () => {
        vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
          if (init?.method === 'POST') {
            throw new TypeError('fetch failed');
          }
          return realFetch(`${betaBaseUrl}${new URL(String(input)).pathname}`, init);
        });
        const jobId = nextJobId();

        const res = await submitOnAlpha(jobId);

        expect(res.status).toBe(502);
        await expect(res.json()).resolves.toMatchObject({ message: `Peer ${BETA_FQDN} did not answer the dispatch of training job ${jobId}` });
      });

      it("gets a 502 carrying beta's reason when beta refuses a path outside its training data directory", async () => {
        const jobId = nextJobId();
        const body = offloaded(jobId);
        // Alpha's operator may name any path on alpha; beta takes only its training data directory.
        body.dataset = { ...body.dataset, dataPath: path.join(DATA_DIR, 'state', 'seed') };

        const res = await requestAs(alphaBaseUrl, 'operator', 'POST', '/api/training/jobs', body);

        expect(res.status).toBe(502);
        await expect(res.json()).resolves.toMatchObject({
          message: `Peer ${BETA_FQDN} refused training job ${jobId} with HTTP 400: dataset.dataPath must name an existing path in this Hub's training data directory`,
        });
        expect(submitJob).not.toHaveBeenCalled();
      });
    });
  });
});
