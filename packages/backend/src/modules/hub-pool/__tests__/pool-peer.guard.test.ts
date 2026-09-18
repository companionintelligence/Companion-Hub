import { createHash, randomUUID } from 'node:crypto';
import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { Request } from 'express';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { DEFAULT_POOL_HEALTH_POLL_SECONDS, DEFAULT_POOL_LOCAL_AFFINITY, type HubPoolPreferences } from '@/common/helpers/hub-pool';
import { HubPoolPeerRepository } from '../hub-pool-peer.repository';
import { HubPoolIdentityService } from '../hub-pool-identity.service';
import { PoolPeerGuard } from '../guards/pool-peer.guard';
import {
  buildSignedPoolHeaders,
  generatePoolKeyPair,
  privateKeyFromBase64,
  POOL_RECIPIENT_HEADER,
  POOL_REFUSAL_HEADER,
  POOL_REFUSAL_IDENTITY_MISMATCH,
  POOL_SIGNATURE_HEADER,
} from '../hub-pool-peer-auth';

const PAIRED_TOKEN = 'a'.repeat(64);
const SELF_UUID = '11111111-1111-4111-8111-111111111111';
const PEER_UUID = '22222222-2222-4222-8222-222222222222';
const CAPABILITIES_PATH = '/api/inference/pool/capabilities';

const peerKeys = generatePoolKeyPair();

function preferences(overrides: Partial<HubPoolPreferences> = {}): HubPoolPreferences {
  return {
    poolEnabled: true,
    poolOutboundEnabled: true,
    poolInboundEnabled: true,
    poolLocalAffinity: DEFAULT_POOL_LOCAL_AFFINITY,
    poolHealthPollSeconds: DEFAULT_POOL_HEALTH_POLL_SECONDS,
    poolPins: [],
    poolRequireSignedPeers: false,
    ...overrides,
  };
}

function mockPeer(overrides: Partial<HubPoolPeer> = {}): HubPoolPeer {
  return {
    id: 'peer-1',
    tailscaleDeviceId: null,
    nodeFqdn: 'hub-b.example-tailnet.ts.net',
    displayName: 'Beta Hub',
    direction: 'outbound',
    status: 'connected',
    enabled: true,
    consecutiveFailures: 0,
    lastSeenAt: new Date().toISOString(),
    lastCapabilities: null,
    verifyTokenHash: createHash('sha256').update(PAIRED_TOKEN).digest('hex'),
    presentTokenEncrypted: 'encrypted',
    peerNodeUuid: null,
    peerPublicKey: null,
    bearerGraceUntil: null,
    signedSeenAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A peer that has completed the identity exchange but has not yet been seen signing anything. */
function signedPeer(overrides: Partial<HubPoolPeer> = {}): HubPoolPeer {
  return mockPeer({ peerNodeUuid: PEER_UUID, peerPublicKey: peerKeys.publicKey, ...overrides });
}

/**
 * Only the fields the guard actually reads, so a test cannot pass on something the guard never sees.
 * `method`/`originalUrl`/`body` matter now that the signature covers them.
 */
function createContext(
  headers: Record<string, string>,
  request: { method?: string; originalUrl?: string; body?: unknown } = {},
): { context: ExecutionContext; request: Request } {
  const req = {
    header: (name: string) => headers[name.toLowerCase()],
    method: request.method ?? 'GET',
    originalUrl: request.originalUrl ?? CAPABILITIES_PATH,
    url: request.originalUrl ?? CAPABILITIES_PATH,
    path: request.originalUrl ?? CAPABILITIES_PATH,
    body: request.body,
  } as unknown as Request;
  return { context: { switchToHttp: () => ({ getRequest: () => req }) } as ExecutionContext, request: req };
}

function peerHeaders(nodeFqdn: string, token: string): Record<string, string> {
  return { 'x-hub-pool-peer': nodeFqdn, authorization: `Bearer ${token}` };
}

/** Lower-cases the header names the way Express delivers them to `request.header()`. */
function signedHeaders(
  parts: { method?: string; path?: string; senderNodeFqdn?: string; recipientNodeUuid?: string; body?: unknown } = {},
  now = Date.now(),
): Record<string, string> {
  const built = buildSignedPoolHeaders(
    privateKeyFromBase64(peerKeys.privateKey),
    {
      method: parts.method ?? 'GET',
      path: parts.path ?? CAPABILITIES_PATH,
      senderNodeUuid: PEER_UUID,
      senderNodeFqdn: parts.senderNodeFqdn ?? 'hub-b.example-tailnet.ts.net',
      recipientNodeUuid: parts.recipientNodeUuid ?? SELF_UUID,
      body: parts.body,
    },
    now,
  );
  return Object.fromEntries(Object.entries(built).map(([key, value]) => [key.toLowerCase(), value]));
}

describe('PoolPeerGuard', () => {
  let repo: MockProxy<HubPoolPeerRepository>;
  let identity: MockProxy<HubPoolIdentityService>;
  let configuration: MockProxy<ConfigurationService>;
  let guard: PoolPeerGuard;

  beforeEach(() => {
    repo = mock<HubPoolPeerRepository>();
    identity = mock<HubPoolIdentityService>();
    identity.get.mockResolvedValue({ nodeUuid: SELF_UUID, publicKey: 'irrelevant', privateKey: null });
    configuration = mock<ConfigurationService>();
    configuration.getHubPoolPreferences.mockImplementation(() => preferences());
    repo.update.mockImplementation(async (_id, data) => ({ ...mockPeer(), ...(data as Partial<HubPoolPeer>) }));
    guard = new PoolPeerGuard(repo, identity, configuration, mock<LoggerService>());
  });

  describe('background cost on a peerless Hub', () => {
    it('holds no nonce-sweep timer until a signed request actually stores a nonce', () => {
      // The cost this pins. The guard used to arm a 30s `setInterval` from `onModuleInit` on every
      // Hub in the fleet, sweeping a map that stays empty forever on the overwhelming majority of
      // them — the ones with no pool peers, which never send a signed request at all.
      expect(guard.hasNonceSweeper()).toBe(false);
    });

    it('arms the sweeper the moment there is something to sweep', async () => {
      repo.findByNodeUuid.mockResolvedValue(signedPeer());

      await expect(guard.canActivate(createContext(signedHeaders()).context)).resolves.toBe(true);

      expect(guard.hasNonceSweeper()).toBe(true);
    });

    it('releases it again on destroy', async () => {
      repo.findByNodeUuid.mockResolvedValue(signedPeer());
      await guard.canActivate(createContext(signedHeaders()).context);

      guard.onModuleDestroy();

      expect(guard.hasNonceSweeper()).toBe(false);
    });
  });

  describe('bearer branch (legacy — must stay byte-identical for an un-upgraded peer)', () => {
    it('admits a paired peer presenting the token this Hub issued it, and hands the row to the handler', async () => {
      const peer = mockPeer();
      repo.findByNodeFqdn.mockResolvedValue(peer);
      const { context, request } = createContext(peerHeaders(peer.nodeFqdn, PAIRED_TOKEN));

      await expect(guard.canActivate(context)).resolves.toBe(true);

      // Handlers read `poolPeer.nodeFqdn` rather than the caller-supplied header, so the row has to be here.
      expect(request.poolPeer).toBe(peer);
    });

    it('admits a still-pending row, which is what /pair/confirm has to pass through', async () => {
      const pending = mockPeer({ status: 'pending' });
      repo.findByNodeFqdn.mockResolvedValue(pending);

      await expect(guard.canActivate(createContext(peerHeaders(pending.nodeFqdn, PAIRED_TOKEN)).context)).resolves.toBe(true);
    });

    it('resolves a peer that spells its own name with a trailing dot and mixed case', async () => {
      repo.findByNodeFqdn.mockResolvedValue(mockPeer());

      await expect(guard.canActivate(createContext(peerHeaders('Hub-B.Example-Tailnet.TS.NET.', PAIRED_TOKEN)).context)).resolves.toBe(true);

      // Rows are stored canonicalized, so the lookup has to be too or a legitimate peer 401s forever.
      expect(repo.findByNodeFqdn).toHaveBeenCalledWith('hub-b.example-tailnet.ts.net');
    });

    it.each([
      ['no headers at all', {}],
      ['a peer name but no token', { 'x-hub-pool-peer': 'hub-b.example-tailnet.ts.net' }],
      ['a token but no peer name', { authorization: `Bearer ${PAIRED_TOKEN}` }],
      ['a non-Bearer authorization scheme', { 'x-hub-pool-peer': 'hub-b.example-tailnet.ts.net', authorization: `Basic ${PAIRED_TOKEN}` }],
    ])('refuses a request with %s, without touching the peer table', async (_label, headers) => {
      await expect(guard.canActivate(createContext(headers).context)).rejects.toThrow(UnauthorizedException);

      expect(repo.findByNodeFqdn).not.toHaveBeenCalled();
    });

    it.each([
      'https://hub-b.example-tailnet.ts.net',
      'hub-b.example-tailnet.ts.net:8443',
      '100.64.0.1',
      'nodots',
    ])('refuses %s as a peer name before it reaches the lookup', async (nodeFqdn) => {
      await expect(guard.canActivate(createContext(peerHeaders(nodeFqdn, PAIRED_TOKEN)).context)).rejects.toThrow(UnauthorizedException);

      expect(repo.findByNodeFqdn).not.toHaveBeenCalled();
    });

    it('refuses a tailnet device that has never been paired', async () => {
      // The core security property: being on the tailnet does not grant use of a peer-facing route.
      repo.findByNodeFqdn.mockResolvedValue(undefined);

      await expect(guard.canActivate(createContext(peerHeaders('laptop.example-tailnet.ts.net', PAIRED_TOKEN)).context)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('refuses a peer we have not yet issued a token to, however good its own token is', async () => {
      // Our outbound pending row: we hold THEIR token to present, but have issued none to verify against.
      repo.findByNodeFqdn.mockResolvedValue(mockPeer({ direction: 'outbound', status: 'pending', verifyTokenHash: null }));

      await expect(guard.canActivate(createContext(peerHeaders('hub-b.example-tailnet.ts.net', PAIRED_TOKEN)).context)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('refuses the wrong token for a genuinely paired peer', async () => {
      repo.findByNodeFqdn.mockResolvedValue(mockPeer());

      await expect(guard.canActivate(createContext(peerHeaders('hub-b.example-tailnet.ts.net', 'b'.repeat(64))).context)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('refuses a live token belonging to a different peer — a credential is only valid for its own row', async () => {
      const peerC = mockPeer({
        id: 'peer-c',
        nodeFqdn: 'hub-c.example-tailnet.ts.net',
        verifyTokenHash: createHash('sha256').update('c-token').digest('hex'),
      });
      repo.findByNodeFqdn.mockImplementation(async (nodeFqdn) => (nodeFqdn === peerC.nodeFqdn ? peerC : mockPeer()));

      // `c-token` authenticates hub-c perfectly well; claiming to be hub-b while holding it must not work.
      await expect(guard.canActivate(createContext(peerHeaders('hub-b.example-tailnet.ts.net', 'c-token')).context)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(guard.canActivate(createContext(peerHeaders('hub-c.example-tailnet.ts.net', 'c-token')).context)).resolves.toBe(true);
    });

    it('answers 401 when the stored hash and the presented one differ in length', async () => {
      repo.findByNodeFqdn.mockResolvedValue(mockPeer({ verifyTokenHash: 'not-a-full-length-sha256' }));

      // timingSafeEqual throws a RangeError on mismatched lengths, which Nest would surface as a 500 —
      // a different, observable answer from the 401 a merely-wrong token gets.
      await expect(guard.canActivate(createContext(peerHeaders('hub-b.example-tailnet.ts.net', PAIRED_TOKEN)).context)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('never consults the peer table when this node requires signed peers', async () => {
      configuration.getHubPoolPreferences.mockImplementation(() => preferences({ poolRequireSignedPeers: true }));
      repo.findByNodeFqdn.mockResolvedValue(mockPeer());

      await expect(guard.canActivate(createContext(peerHeaders('hub-b.example-tailnet.ts.net', PAIRED_TOKEN)).context)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(repo.findByNodeFqdn).not.toHaveBeenCalled();
    });
  });

  describe('signed branch', () => {
    it('admits a signed request from a pinned peer and hands the row to the handler', async () => {
      const peer = signedPeer();
      repo.findByNodeUuid.mockResolvedValue(peer);
      const { context, request } = createContext(signedHeaders());

      await expect(guard.canActivate(context)).resolves.toBe(true);

      expect(repo.findByNodeUuid).toHaveBeenCalledWith(PEER_UUID);
      expect(request.poolPeer?.id).toBe(peer.id);
    });

    it('records that the peer signed, so the health tick can retire both bearer tokens', async () => {
      repo.findByNodeUuid.mockResolvedValue(signedPeer({ bearerGraceUntil: new Date(Date.now() + 60_000).toISOString() }));

      await guard.canActivate(createContext(signedHeaders()).context);

      expect(repo.update).toHaveBeenCalledWith('peer-1', expect.objectContaining({ signedSeenAt: expect.any(String), bearerGraceUntil: null }));
    });

    it('stops writing once the row is settled, so a signed peer costs no database write per request', async () => {
      repo.findByNodeUuid.mockResolvedValue(signedPeer({ signedSeenAt: new Date().toISOString(), bearerGraceUntil: null }));

      await guard.canActivate(createContext(signedHeaders()).context);

      expect(repo.update).not.toHaveBeenCalled();
    });

    it('refuses a UUID that matches no pinned row', async () => {
      repo.findByNodeUuid.mockResolvedValue(undefined);

      await expect(guard.canActivate(createContext(signedHeaders()).context)).rejects.toThrow(UnauthorizedException);
    });

    it('refuses a signature over a different method, path, sender name or recipient', async () => {
      repo.findByNodeUuid.mockResolvedValue(signedPeer());

      // Signed for GET /capabilities, presented on POST /pair/upgrade.
      const wrongRoute = createContext(signedHeaders(), { method: 'POST', originalUrl: '/api/inference/pool/pair/upgrade' });
      await expect(guard.canActivate(wrongRoute.context)).rejects.toThrow(UnauthorizedException);

      // Signed naming a different sender FQDN than the header claims.
      const drifted = signedHeaders({ senderNodeFqdn: 'hub-z.example-tailnet.ts.net' });
      await expect(guard.canActivate(createContext({ ...drifted, 'x-hub-pool-peer': 'hub-b.example-tailnet.ts.net' }).context)).rejects.toThrow(
        UnauthorizedException,
      );

      // Signed for a different recipient — the property that makes a signature non-transferable.
      await expect(guard.canActivate(createContext(signedHeaders({ recipientNodeUuid: randomUUID() })).context)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('refuses a signature over a different body on a control route', async () => {
      repo.findByNodeUuid.mockResolvedValue(signedPeer());
      const path = '/api/inference/pool/pair/upgrade';
      const headers = signedHeaders({ method: 'POST', path, body: { nodeUuid: PEER_UUID, publicKey: peerKeys.publicKey } });

      const swapped = createContext(headers, { method: 'POST', originalUrl: path, body: { nodeUuid: PEER_UUID, publicKey: 'someone-elses-key' } });
      await expect(guard.canActivate(swapped.context)).rejects.toThrow(UnauthorizedException);
    });

    it('does not bind the body on the inference forwarding path, which is why a megabyte batch is affordable', async () => {
      repo.findByNodeUuid.mockResolvedValue(signedPeer());
      const path = '/api/inference/pool/local/v1/embeddings';
      const headers = signedHeaders({ method: 'POST', path, body: { input: 'signed with this' } });

      const different = createContext(headers, { method: 'POST', originalUrl: path, body: { input: 'delivered with that' } });
      await expect(guard.canActivate(different.context)).resolves.toBe(true);
    });

    it('refuses a replayed nonce, and a timestamp outside the skew window', async () => {
      repo.findByNodeUuid.mockResolvedValue(signedPeer());
      const headers = signedHeaders();

      await expect(guard.canActivate(createContext(headers).context)).resolves.toBe(true);
      await expect(guard.canActivate(createContext(headers).context)).rejects.toThrow(UnauthorizedException);

      await expect(guard.canActivate(createContext(signedHeaders({}, Date.now() - 300_001)).context)).rejects.toThrow(UnauthorizedException);
    });

    it('refuses a signed request when this node has no usable identity to be the recipient of', async () => {
      identity.get.mockResolvedValue(null);
      repo.findByNodeUuid.mockResolvedValue(signedPeer());

      await expect(guard.canActivate(createContext(signedHeaders()).context)).rejects.toThrow(UnauthorizedException);
      expect(repo.findByNodeUuid).not.toHaveBeenCalled();
    });

    it('refuses a signature header that is not the versioned form, before doing any curve work', async () => {
      repo.findByNodeUuid.mockResolvedValue(signedPeer());
      const headers = { ...signedHeaders(), [POOL_SIGNATURE_HEADER.toLowerCase()]: 'not-a-versioned-signature' };

      await expect(guard.canActivate(createContext(headers).context)).rejects.toThrow(UnauthorizedException);
    });

    it('records a verified name change for the health tick instead of writing the UNIQUE column here', async () => {
      const peer = signedPeer({ nodeFqdn: 'hub-old.example-tailnet.ts.net' });
      repo.findByNodeUuid.mockResolvedValue(peer);

      await expect(guard.canActivate(createContext(signedHeaders({ senderNodeFqdn: 'hub-new.example-tailnet.ts.net' })).context)).resolves.toBe(true);

      // The whole point: a rename is recorded, never written from the request path — `node_fqdn` is
      // UNIQUE, so a collision here would 500 an authenticated request and permanently redirect this
      // Hub's outbound pool traffic on the strength of a header.
      expect(identity.noteObservedPeerFqdn).toHaveBeenCalledWith(peer.id, 'hub-new.example-tailnet.ts.net');
      expect(repo.update).not.toHaveBeenCalledWith(peer.id, expect.objectContaining({ nodeFqdn: expect.anything() }));
    });
  });

  describe('a request addressed to an identity this node no longer holds', () => {
    /** A context whose HTTP response records the headers the guard sets before it throws. */
    function contextWithResponse(headers: Record<string, string>): { context: ExecutionContext; responseHeaders: Map<string, string> } {
      const { request } = createContext(headers);
      const responseHeaders = new Map<string, string>();
      const response = { setHeader: (name: string, value: string) => responseHeaders.set(name, value) };
      const context = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) } as unknown as ExecutionContext;
      return { context, responseHeaders };
    }

    it('names the mismatch, so a peer probing a recreated node can tell it from clock skew', async () => {
      // beta-max after its database volume was recreated: a peer still signs for the UUID it pinned,
      // and this node has neither that UUID nor a row for the sender.
      const staleRecipient = randomUUID();
      const { context, responseHeaders } = contextWithResponse(signedHeaders({ recipientNodeUuid: staleRecipient }));

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);

      expect(responseHeaders.get(POOL_REFUSAL_HEADER)).toBe(POOL_REFUSAL_IDENTITY_MISMATCH);
      // Decided before the table is touched, because the node this is for has no row to find.
      expect(repo.findByNodeUuid).not.toHaveBeenCalled();
    });

    it('never names this node’s actual UUID in the refusal', async () => {
      const { context, responseHeaders } = contextWithResponse(signedHeaders({ recipientNodeUuid: randomUUID() }));

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);

      expect([...responseHeaders.values()].join(' ')).not.toContain(SELF_UUID);
    });

    it('names nothing for any other refusal, so the header is not an oracle for which check failed', async () => {
      repo.findByNodeUuid.mockResolvedValue(undefined);
      const { context, responseHeaders } = contextWithResponse(signedHeaders());

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);

      expect(responseHeaders.size).toBe(0);
    });

    it('still refuses a signature for another recipient when the clear header is forged to match', async () => {
      // The header is advisory. The signature is what binds the recipient, and it must still fail.
      repo.findByNodeUuid.mockResolvedValue(signedPeer());
      const headers = { ...signedHeaders({ recipientNodeUuid: randomUUID() }), [POOL_RECIPIENT_HEADER.toLowerCase()]: SELF_UUID };
      const { context, responseHeaders } = contextWithResponse(headers);

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);

      expect(responseHeaders.size).toBe(0);
    });

    it('verifies a sender predating the recipient header exactly as before', async () => {
      repo.findByNodeUuid.mockResolvedValue(signedPeer());
      const { [POOL_RECIPIENT_HEADER.toLowerCase()]: _dropped, ...legacy } = signedHeaders();

      await expect(guard.canActivate(createContext(legacy).context)).resolves.toBe(true);
    });

    it('still refuses without a response to annotate, rather than failing open', async () => {
      await expect(guard.canActivate(createContext(signedHeaders({ recipientNodeUuid: randomUUID() })).context)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('the no-downgrade rule', () => {
    it('refuses a bearer token from a peer that has already been observed signing', async () => {
      // The most important assertion in this change: once the upgrade is demonstrably complete, the
      // old credential stops working, so a stolen database backup holds tokens that open nothing.
      repo.findByNodeFqdn.mockResolvedValue(signedPeer({ signedSeenAt: new Date().toISOString() }));

      await expect(guard.canActivate(createContext(peerHeaders('hub-b.example-tailnet.ts.net', PAIRED_TOKEN)).context)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('still admits the bearer token from a pinned peer that has never been seen signing', async () => {
      // The self-healing half. If the upgrade landed here but its reply never reached the peer, the
      // peer is still — correctly — presenting a token, and refusing it would strand the pairing
      // with no recovery path. `bearerGraceUntil` bounds how long this node waits for the evidence.
      repo.findByNodeFqdn.mockResolvedValue(signedPeer({ bearerGraceUntil: new Date(Date.now() + 600_000).toISOString() }));

      await expect(guard.canActivate(createContext(peerHeaders('hub-b.example-tailnet.ts.net', PAIRED_TOKEN)).context)).resolves.toBe(true);
    });

    it('does not refuse an un-upgraded peer that has no pinned key at all', async () => {
      repo.findByNodeFqdn.mockResolvedValue(mockPeer({ signedSeenAt: new Date().toISOString() }));

      await expect(guard.canActivate(createContext(peerHeaders('hub-b.example-tailnet.ts.net', PAIRED_TOKEN)).context)).resolves.toBe(true);
    });
  });
});
