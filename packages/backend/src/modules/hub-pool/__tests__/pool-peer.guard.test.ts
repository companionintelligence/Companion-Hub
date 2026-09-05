import { createHash } from 'node:crypto';
import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { Request } from 'express';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { HubPoolPeerRepository } from '../hub-pool-peer.repository';
import { PoolPeerGuard } from '../guards/pool-peer.guard';

const PAIRED_TOKEN = 'a'.repeat(64);

function mockPeer(overrides: Partial<HubPoolPeer> = {}): HubPoolPeer {
  return {
    id: 'peer-1',
    tailscaleDeviceId: null,
    nodeFqdn: 'hub-b.example-tailnet.ts.net',
    displayName: 'Beta Hub',
    direction: 'outbound',
    status: 'connected',
    consecutiveFailures: 0,
    lastSeenAt: new Date().toISOString(),
    lastCapabilities: null,
    verifyTokenHash: createHash('sha256').update(PAIRED_TOKEN).digest('hex'),
    presentTokenEncrypted: 'encrypted',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Only the two headers the guard reads, so a test cannot pass on something the guard never sees. */
function createContext(headers: Record<string, string>): { context: ExecutionContext; request: Request } {
  const request = {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  return { context: { switchToHttp: () => ({ getRequest: () => request }) } as ExecutionContext, request };
}

function peerHeaders(nodeFqdn: string, token: string): Record<string, string> {
  return { 'x-hub-pool-peer': nodeFqdn, authorization: `Bearer ${token}` };
}

describe('PoolPeerGuard', () => {
  let repo: MockProxy<HubPoolPeerRepository>;
  let guard: PoolPeerGuard;

  beforeEach(() => {
    repo = mock<HubPoolPeerRepository>();
    guard = new PoolPeerGuard(repo);
  });

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
});
