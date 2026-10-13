/**
 * Who may spend this Hub's (and its peers') GPU time through the inference surface, and what it
 * costs to decide.
 *
 * Two facts the fleet lived with until 2026-09-18:
 * - `/api/inference/v1/*` was reachable through a registered Hub's Cloudflare tunnel with no
 *   credential: `InternalNetworkGuard` alone, which passes proxy traffic while `HUB_TRUST_PROXY` is
 *   unset, and no middleware on the `hub-public` router or the tunnel ingress.
 * - Every app on the appliance sends a placeholder bearer (`ollama`, its backend key) on every
 *   turn, and a desktop runner sends a 64-hex key of its own. Any check that looked those up would
 *   put a SELECT — and, during a database blip, 550 ms of retries — on the inference hot path.
 *
 * So every admission below is paired with an assertion on `findByHash`: the internal leg must never
 * touch the key store, and the key leg must touch it exactly once. The key store is a real
 * `ApiKeyService` over an in-memory table, so the scope check is the service's own.
 */
import { HttpStatus, RequestMethod, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyStoreUnavailableError } from '@/modules/api-keys/api-key.errors';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { HubPoolOllamaCompatController } from '@/modules/hub-pool/hub-pool-ollama-compat.controller';
import { HubPoolController } from '@/modules/hub-pool/hub-pool.controller';
import { InferenceController } from '@/modules/inference/inference.controller';
import { InferenceAccessGuard, type InferenceAuthenticatedRequest } from '../inference-access.guard';

const INFERENCE_KEY = 'a'.repeat(64);
const MCP_KEY = 'b'.repeat(64);
const UNKNOWN_KEY = 'c'.repeat(64);

const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');
const rows = new Map([
  [
    sha256(INFERENCE_KEY),
    { id: 1, name: 'laptop-zed', scopes: ['inference'], capability: 'read', managed: false, ownerAppUrn: null, expiresAt: null },
  ],
  [sha256(MCP_KEY), { id: 2, name: 'laptop-cli', scopes: ['mcp'], capability: 'write', managed: false, ownerAppUrn: null, expiresAt: null }],
]);

/** Enough of an Express `Response` to record what the guard wrote, and whether it wrote at all. */
function fakeResponse() {
  const res = {
    headers: {} as Record<string, string>,
    statusCode: 0,
    body: undefined as unknown,
    headersSent: false,
    setHeader(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      res.headersSent = true;
      return res;
    },
  };
  return res;
}

type FakeResponse = ReturnType<typeof fakeResponse>;

const contextFor = (request: InferenceAuthenticatedRequest, response: FakeResponse) =>
  ({
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  }) as unknown as ExecutionContext;

/** A request as Express hands it over: `ip` resolved, headers lower-cased, the route on `originalUrl`. */
const request = (ip: string, headers: Record<string, string | string[]> = {}): InferenceAuthenticatedRequest => ({
  ip,
  method: 'POST',
  originalUrl: '/api/inference/v1/chat/completions',
  headers,
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('InferenceAccessGuard', () => {
  const repo = { findByHash: vi.fn(), touchLastUsed: vi.fn() };
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  let apiKeys: ApiKeyService;
  let guard: InferenceAccessGuard;

  beforeEach(() => {
    vi.clearAllMocks();
    repo.findByHash.mockImplementation(async (hash: string) => rows.get(hash));
    repo.touchLastUsed.mockResolvedValue(undefined);
    apiKeys = new ApiKeyService(repo as never, logger as never);
    guard = new InferenceAccessGuard(logger as never, apiKeys);
  });

  /** The verdict and the body, for a refusal that both wrote the response and threw. */
  const refusalOf = async (req: InferenceAuthenticatedRequest) => {
    const res = fakeResponse();
    const error = await guard.canActivate(contextFor(req, res)).catch((err) => err);
    return { error, res };
  };

  describe('an internal origin', () => {
    /**
     * The whole point of the first leg. An app sends `Bearer ollama` (or its backend key) on every
     * turn; a desktop runner sends its own 64-hex key. None of them is a Hub key, and the guard must
     * not find that out by asking the database.
     */
    it.each([
      ['no Authorization header', {}],
      ['a placeholder bearer', bearer('ollama')],
      ['a 64-hex bearer that is not a Hub key', bearer(UNKNOWN_KEY)],
      ['a bearer that is a Hub key', bearer(INFERENCE_KEY)],
    ])('is admitted with %s, and the key store is never consulted', async (_label, headers) => {
      const req = request('172.18.0.5', { host: 'ci-hub:3000', ...headers });
      const res = fakeResponse();

      await expect(guard.canActivate(contextFor(req, res))).resolves.toBe(true);

      expect(repo.findByHash).not.toHaveBeenCalled();
      expect(res.headersSent).toBe(false);
      expect(req.inferenceApiKey).toBeUndefined();
    });

    it('includes a wholly private forwarded chain — a tailnet peer behind the Docker bridge', async () => {
      const req = request('172.18.0.2', { 'x-forwarded-for': '172.18.0.2, 100.101.102.103' });

      await expect(guard.canActivate(contextFor(req, fakeResponse()))).resolves.toBe(true);

      expect(repo.findByHash).not.toHaveBeenCalled();
    });
  });

  describe('a request the Hub cannot place inside', () => {
    /**
     * Behind the tunnel `req.ip` is the proxy's own private address, so the old guard passed this.
     * The body is OpenAI's shape because that is what every editor and SDK reads `error.message`
     * from, and `WWW-Authenticate` tells an SDK which credential it is missing.
     */
    it('is refused 401 in the OpenAI error shape when it carries no key', async () => {
      const { error, res } = await refusalOf(request('172.18.0.2', { 'cf-ray': '8f1a-LHR' }));

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(res.statusCode).toBe(HttpStatus.UNAUTHORIZED);
      expect(res.headers['WWW-Authenticate']).toBe('Bearer realm="ci-hub-inference"');
      expect(res.body).toEqual({
        error: {
          message: expect.stringContaining('cihub api-key create --scope inference'),
          type: 'authentication_error',
          code: 'missing_api_key',
        },
      });
      expect(repo.findByHash).not.toHaveBeenCalled();
    });

    it('is admitted with a valid inference key, which the handler can then read', async () => {
      const req = request('172.18.0.2', { 'cf-ray': '8f1a-LHR', ...bearer(INFERENCE_KEY) });
      const res = fakeResponse();

      await expect(guard.canActivate(contextFor(req, res))).resolves.toBe(true);

      expect(repo.findByHash).toHaveBeenCalledTimes(1);
      expect(req.inferenceApiKey).toMatchObject({ id: 1, name: 'laptop-zed', capability: 'read' });
      expect(res.headersSent).toBe(false);
    });

    /**
     * The inference key is not an operator. Every guard that asks "is there a person here" must keep
     * saying no for it, and `hub-session.guard.test.ts` pins that only `AuthMiddleware` sets the
     * principal; this guard sets its own property and nothing else.
     */
    it('never installs a user or a principal, even when it admits a key', async () => {
      const req = request('172.18.0.2', { 'cf-ray': '8f1a-LHR', ...bearer(INFERENCE_KEY) });

      await guard.canActivate(contextFor(req, fakeResponse()));

      expect((req as { user?: unknown }).user).toBeUndefined();
      expect((req as { hubPrincipal?: unknown }).hubPrincipal).toBeUndefined();
      expect(repo.findByHash).toHaveBeenCalledTimes(1);
    });

    /** A leaked editor credential must open nothing but inference; the converse holds too. */
    it('refuses an mcp-only key with 401 invalid_api_key', async () => {
      const { error, res } = await refusalOf(request('172.18.0.2', { 'cf-ray': '8f1a-LHR', ...bearer(MCP_KEY) }));

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(res.statusCode).toBe(HttpStatus.UNAUTHORIZED);
      expect(res.body).toEqual({
        error: { message: expect.stringContaining('does not carry the inference scope'), type: 'authentication_error', code: 'invalid_api_key' },
      });
      expect(repo.findByHash).toHaveBeenCalledTimes(1);
    });

    it('refuses a key this Hub never minted with the same 401', async () => {
      const { error, res } = await refusalOf(request('172.18.0.2', { 'cf-ray': '8f1a-LHR', ...bearer(UNKNOWN_KEY) }));

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((res.body as { error: { code: string } }).error.code).toBe('invalid_api_key');
      // A row that is absent is looked up once, like a row that is present: no retry on not-found.
      expect(repo.findByHash).toHaveBeenCalledTimes(1);
    });

    /** `HUB_TRUST_PROXY` set, or a caller on the API port directly: a public `req.ip`, no markers. */
    it('is admitted from a public address with a valid key', async () => {
      const req = request('203.0.113.10', bearer(INFERENCE_KEY));

      await expect(guard.canActivate(contextFor(req, fakeResponse()))).resolves.toBe(true);

      expect(req.inferenceApiKey?.id).toBe(1);
      expect(repo.findByHash).toHaveBeenCalledTimes(1);
    });

    it('needs a key once any forwarded hop is public, and admits one', async () => {
      const without = await refusalOf(request('172.18.0.2', { 'x-forwarded-for': '203.0.113.10, 172.18.0.2' }));
      expect(without.res.statusCode).toBe(HttpStatus.UNAUTHORIZED);
      expect(repo.findByHash).not.toHaveBeenCalled();

      const req = request('172.18.0.2', { 'x-forwarded-for': '203.0.113.10, 172.18.0.2', ...bearer(INFERENCE_KEY) });
      await expect(guard.canActivate(contextFor(req, fakeResponse()))).resolves.toBe(true);
      expect(repo.findByHash).toHaveBeenCalledTimes(1);
    });
  });

  describe('what never costs a lookup', () => {
    it.each([
      ['a header that is not `Bearer <token>`', { authorization: `Basic ${INFERENCE_KEY}` }],
      ['a bearer with a space in the token', { authorization: `Bearer ${INFERENCE_KEY} extra` }],
      ['an empty bearer', { authorization: 'Bearer' }],
      ['a bearer with nothing after the space', { authorization: 'Bearer ' }],
    ])('refuses %s as missing_api_key without asking the store', async (_label, headers) => {
      const { error, res } = await refusalOf(request('172.18.0.2', { 'cf-ray': '8f1a-LHR', ...headers }));

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((res.body as { error: { code: string } }).error.code).toBe('missing_api_key');
      expect(repo.findByHash).not.toHaveBeenCalled();
    });

    /**
     * A placeholder bearer that reached the Hub through a proxy — an app misconfigured to call the
     * public hostname, say. It cannot be a key this Hub minted, so it is refused as one that is not,
     * and it costs neither a SELECT nor, during a database blip, the retries.
     */
    it.each(['ollama', 'sk-local', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)])(
      'refuses a token not shaped like a Hub key (%s) as invalid_api_key without asking the store',
      async (token) => {
        const { error, res } = await refusalOf(request('172.18.0.2', { 'cf-ray': '8f1a-LHR', ...bearer(token) }));

        expect(error).toBeInstanceOf(UnauthorizedException);
        expect((res.body as { error: { code: string } }).error.code).toBe('invalid_api_key');
        expect(repo.findByHash).not.toHaveBeenCalled();
      },
    );
  });

  /**
   * "Could not check your key" is not "your key is wrong" (#933). A 401 here would send an operator
   * rotating a good key while the database is the thing that is down; a 503 sends SDKs into their
   * retry path and operators to infrastructure.
   */
  it('answers 503 in the OpenAI error shape when the key store cannot be reached', async () => {
    vi.spyOn(apiKeys, 'resolve').mockRejectedValue(new ApiKeyStoreUnavailableError(new Error('getaddrinfo EAI_AGAIN ci-hub-db')));

    const { error, res } = await refusalOf(request('172.18.0.2', { 'cf-ray': '8f1a-LHR', ...bearer(INFERENCE_KEY) }));

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(res.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(res.body).toEqual({ error: { message: 'Authentication temporarily unavailable — API key store unreachable', type: 'server_error' } });
    expect(res.headers['WWW-Authenticate']).toBeUndefined();
  });

  it('rethrows a query bug rather than dressing it as an auth verdict', async () => {
    const bug = new Error('relation "api_key" does not exist');
    vi.spyOn(apiKeys, 'resolve').mockRejectedValue(bug);

    const { error, res } = await refusalOf(request('172.18.0.2', { 'cf-ray': '8f1a-LHR', ...bearer(INFERENCE_KEY) }));

    expect(error).toBe(bug);
    expect(res.headersSent).toBe(false);
  });

  it('logs the path and the reason, never the token', async () => {
    await refusalOf(request('172.18.0.2', { 'cf-ray': '8f1a-LHR', ...bearer(UNKNOWN_KEY) }));
    await refusalOf(request('172.18.0.2', { 'cf-ray': '8f1a-LHR', ...bearer('ollama') }));

    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('POST /api/inference/v1/chat/completions');
    expect(logged).toContain('origin=tunnel-marker');
    expect(logged).not.toContain(UNKNOWN_KEY);
    expect(logged).not.toContain('ollama');
  });
});

/**
 * The guard is only as good as the routes that carry it, so the whole route table of the three
 * controllers that serve inference is pinned here — every handler, with the exact guard list Nest
 * will run. Nest runs a controller's class-level `@UseGuards` ahead of the handler's own, so each
 * row lists both in that order: a guard added to the class changes every row of that controller,
 * not none of them. A new `/v1` route added without a guard, a guard dropped in a refactor, or a
 * peer route quietly moved onto the app-facing guard, all have to change this test, which is the
 * review point. `apps/:slug/credentials*` carries `InternalOriginGuard`, not this guard, on
 * purpose: the handout is app-only and its body can carry a cloud provider's key, so it takes the
 * origin leg alone with no API-key alternative.
 */
describe('the inference route table', () => {
  it('carries InferenceAccessGuard on exactly the OpenAI- and Ollama-compatible routes, and nothing else moved', () => {
    const guardNames = (target: object) => ((Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as { name: string }[]).map((guard) => guard.name);
    const routes: Record<string, string> = {};
    for (const controller of [InferenceController, HubPoolController, HubPoolOllamaCompatController]) {
      const classGuards = guardNames(controller);
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as unknown as Record<string, unknown>)[name];
        if (typeof handler !== 'function') {
          continue;
        }
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) {
          continue;
        }
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | string[];
        const guards = [...classGuards, ...guardNames(handler)];
        routes[`${controller.name}.${name}`] =
          `${RequestMethod[method]} ${Array.isArray(path) ? path.join('|') : path} → ${guards.join(', ') || '(none)'}`;
      }
    }

    expect(routes).toEqual({
      // ── InferenceController: the six v1 routes are the editor / SDK surface ──
      'InferenceController.v1ChatCompletions': 'POST v1/chat/completions → InferenceAccessGuard',
      'InferenceController.v1Completions': 'POST v1/completions → InferenceAccessGuard',
      'InferenceController.v1Embeddings': 'POST v1/embeddings → InferenceAccessGuard',
      'InferenceController.v1Models': 'GET v1/models → InferenceAccessGuard',
      'InferenceController.v1AudioSpeech': 'POST v1/audio/speech → InferenceAccessGuard',
      'InferenceController.v1AudioTranscriptions': 'POST v1/audio/transcriptions → InferenceAccessGuard',
      'InferenceController.health': 'GET health → (none)',
      'InferenceController.getPreferences': 'GET preferences → AuthGuard',
      'InferenceController.updatePreferences': 'PATCH preferences → AuthGuard',
      'InferenceController.getResidentModels': 'GET models/resident → AuthGuard',
      'InferenceController.getRuntimeModels': 'GET models/runtime → AuthGuard',
      'InferenceController.getStatus': 'GET status → AuthGuard',
      'InferenceController.getSupervision': 'GET supervision → AuthGuard',
      'InferenceController.getHardware': 'GET hardware → AuthGuard',
      'InferenceController.rescanHardware': 'POST hardware/rescan → AuthGuard',
      'InferenceController.getRocmStatus': 'GET rocm/status → AuthGuard',
      'InferenceController.updateRocmInstallState': 'POST rocm/install-state → AuthGuard',
      'InferenceController.getMemory': 'GET memory → AuthGuard',
      'InferenceController.getCatalog': 'GET models/catalog → AuthGuard',
      'InferenceController.getTrackedModels': 'GET models/tracked → AuthGuard',
      'InferenceController.startPullModel': 'POST models/pull/start → AuthGuard, DemoModeGuard',
      'InferenceController.pullModel': 'POST models/pull → AuthGuard, DemoModeGuard',
      'InferenceController.loadModel': 'POST models/load → AuthGuard',
      'InferenceController.unloadModel': 'POST models/unload → AuthGuard',
      'InferenceController.pinModel': 'POST models/pin → AuthGuard',
      'InferenceController.unpinModel': 'POST models/unpin → AuthGuard',
      'InferenceController.getCloudProviders': 'GET cloud-providers → AuthGuard',
      'InferenceController.setCloudProvider': 'POST cloud-providers → AuthGuard',
      'InferenceController.removeCloudProvider': 'DELETE cloud-providers/:provider → AuthGuard',
      'InferenceController.getOnboardingProfile': 'GET onboarding-profile → AuthGuard',
      'InferenceController.getOllamaStatus': 'GET ollama/status → AuthGuard',
      'InferenceController.getLemonadeStatus': 'GET lemonade/status → AuthGuard',
      'InferenceController.getVllmStatus': 'GET vllm/status → AuthGuard',
      'InferenceController.getOmlxStatus': 'GET omlx/status → AuthGuard',
      'InferenceController.getManualEndpointStatus': 'GET manual-endpoint/status → AuthGuard',
      'InferenceController.installOllama': 'POST ollama/install → AuthGuard',
      'InferenceController.getAppCredentials': 'GET apps/:slug/credentials → AppContainerOriginGuard',
      'InferenceController.getAppCredentialsEnv': 'GET apps/:slug/credentials.env|apps/:slug/bootstrap.env → AppContainerOriginGuard',
      // ── HubPoolController: app-facing proxy on the same guard; peers, pairing and operators untouched ──
      'HubPoolController.identify': 'GET identify → (none)',
      'HubPoolController.poolStatus': 'GET status → ObservabilityReadGuard',
      'HubPoolController.getPoolSettings': 'GET settings → AuthGuard',
      'HubPoolController.updatePoolSettings': 'PATCH settings → AuthGuard',
      'HubPoolController.getPoolRoutingLog': 'GET routing-log → ObservabilityReadGuard',
      'HubPoolController.upsertPoolPin': 'POST pins → AuthGuard',
      'HubPoolController.deletePoolPin': 'DELETE pins → AuthGuard',
      'HubPoolController.listPeers': 'GET peers → AuthGuard',
      'HubPoolController.listDiscoverable': 'GET peers/discoverable → AuthGuard',
      'HubPoolController.probePeerAddress': 'POST peers/probe → AuthGuard',
      'HubPoolController.pairPeer': 'POST peers/pair → AuthGuard',
      'HubPoolController.mintPairingPin': 'POST pairing-pin → AuthGuard',
      'HubPoolController.cancelPairingPin': 'DELETE pairing-pin → AuthGuard',
      'HubPoolController.upgradePeer': 'POST peers/:id/upgrade → AuthGuard',
      'HubPoolController.rotateIdentity': 'POST identity/rotate → AuthGuard',
      'HubPoolController.approvePeer': 'POST peers/:id/approve → AuthGuard',
      'HubPoolController.rejectPeer': 'POST peers/:id/reject → AuthGuard',
      'HubPoolController.enablePeer': 'POST peers/:id/enable → AuthGuard',
      'HubPoolController.disablePeer': 'POST peers/:id/disable → AuthGuard',
      'HubPoolController.removePeer': 'DELETE peers/:id → AuthGuard',
      'HubPoolController.handlePairingRequest': 'POST pair/request → (none)',
      'HubPoolController.handlePairingConfirm': 'POST pair/confirm → PoolPeerGuard',
      'HubPoolController.handlePairingUpgrade': 'POST pair/upgrade → PoolPeerGuard',
      'HubPoolController.handlePairingReject': 'POST pair/reject → PoolPeerGuard',
      'HubPoolController.handlePairingUnpair': 'POST pair/unpair → PoolPeerGuard',
      'HubPoolController.capabilities': 'GET capabilities → PoolPeerGuard',
      'HubPoolController.proxyChatCompletions': 'POST v1/chat/completions → InferenceAccessGuard',
      'HubPoolController.proxyCompletions': 'POST v1/completions → InferenceAccessGuard',
      'HubPoolController.proxyEmbeddings': 'POST v1/embeddings → InferenceAccessGuard',
      'HubPoolController.proxyOllamaGenerate': 'POST api/generate → InferenceAccessGuard',
      'HubPoolController.proxyOllamaChat': 'POST api/chat → InferenceAccessGuard',
      'HubPoolController.proxyOllamaEmbeddings': 'POST api/embeddings → InferenceAccessGuard',
      'HubPoolController.proxyOllamaEmbed': 'POST api/embed → InferenceAccessGuard',
      'HubPoolController.proxyOpenAiModelsList': 'GET v1/models → InferenceAccessGuard',
      'HubPoolController.proxyOllamaTags': 'GET api/tags → InferenceAccessGuard',
      'HubPoolController.proxyOllamaPs': 'GET api/ps → InferenceAccessGuard',
      'HubPoolController.proxyOllamaVersion': 'GET api/version → InferenceAccessGuard',
      'HubPoolController.proxyOllamaShow': 'POST api/show → InferenceAccessGuard',
      'HubPoolController.localChatCompletions': 'POST local/v1/chat/completions → PoolPeerGuard',
      'HubPoolController.localCompletions': 'POST local/v1/completions → PoolPeerGuard',
      'HubPoolController.localEmbeddings': 'POST local/v1/embeddings → PoolPeerGuard',
      'HubPoolController.localOllamaGenerate': 'POST local/api/generate → PoolPeerGuard',
      'HubPoolController.localOllamaChat': 'POST local/api/chat → PoolPeerGuard',
      'HubPoolController.localOllamaEmbeddings': 'POST local/api/embeddings → PoolPeerGuard',
      'HubPoolController.localOllamaEmbed': 'POST local/api/embed → PoolPeerGuard',
      'HubPoolController.localOllamaShow': 'POST local/api/show → PoolPeerGuard',
      'HubPoolController.localOpenAiModels': 'GET local/v1/models → PoolPeerGuard',
      'HubPoolController.localOllamaTags': 'GET local/api/tags → PoolPeerGuard',
      // ── HubPoolOllamaCompatController: the root-level OLLAMA_HOST probes ──
      'HubPoolOllamaCompatController.version': 'GET version → InferenceAccessGuard',
      'HubPoolOllamaCompatController.tags': 'GET tags → InferenceAccessGuard',
    });
  });
});
