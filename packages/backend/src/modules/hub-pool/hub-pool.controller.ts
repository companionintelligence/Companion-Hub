import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { INFERENCE_BACKEND_TYPES, type InferenceBackendType } from '@ci-hub/common/types';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { InternalNetworkGuard } from '@/modules/auth/internal-network.guard';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { callerSourceIp, describeHubPoolDisabled, describeHubPoolInboundRefused } from '@/common/helpers/hub-pool';
import { PoolAppGuard } from './guards/pool-app.guard';
import { PoolPeerGuard } from './guards/pool-peer.guard';
import { HubPoolPeerService } from './hub-pool-peer.service';
import { HubPoolRoutingLogService } from './hub-pool-routing-log.service';
import { PoolProxyService } from './hub-pool-proxy.service';
import { HubPoolDiscoveryService } from './hub-pool-discovery.service';
import {
  IncomingPairingRequestBody,
  PairingConfirmBody,
  PairingUpgradeBody,
  PairPeerBody,
  ProbePeerAddressBody,
  RoutingLogQueryDto,
  UpdateHubPoolPreferencesBody,
} from './hub-pool.dto';
import { POOL_PROTOCOL_VERSION } from './hub-pool-peer-auth';
import { toPublicPeer } from './hub-pool.types';

/**
 * Multi-Hub inference pooling.
 *
 * `peers/*` and `pair/*` are the pairing lifecycle (see `HubPoolPeerService`
 * doc comment for the token model). `v1/*` and `api/*` are app-facing —
 * guarded by {@link InternalNetworkGuard} plus {@link PoolAppGuard}, which
 * rejects requests that reached the Hub through the public tunnel — and run
 * full candidate selection + failover. `local/*` are peer-facing — guarded by
 * {@link PoolPeerGuard} — and forward straight to this node's own backend with
 * NO candidate selection, which is what stops a request being relayed through a
 * third node.
 */
@ApiTags('Hub Pool')
@Controller('inference/pool')
export class HubPoolController {
  constructor(
    private readonly peerService: HubPoolPeerService,
    private readonly proxyService: PoolProxyService,
    /**
     * Retained after `identify` stopped disclosing this node's MagicDNS name. Kept so the positional
     * constructor shape every pool test file builds does not shift for a removal nothing needs.
     */
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: kept for the positional constructor shape (see above)
    private readonly tailscaleService: TailscaleService,
    private readonly configuration: ConfigurationService,
    private readonly routingLog: HubPoolRoutingLogService,
    // Appended last on purpose: every pool test file constructs this controller positionally, so a
    // new parameter anywhere else silently re-binds the existing ones.
    private readonly discoveryService: HubPoolDiscoveryService,
  ) {}

  // ── Discovery / identification ──────────────────────────────────────────

  /**
   * The only unauthenticated route in the module that is not a write, and the only one published
   * through the Cloudflare tunnel.
   *
   * It answers exactly two things: that this is a CI-Hub, and which pool protocol it speaks.
   * `nodeFqdn` used to be here and has been removed — a caller already knows the name it dialled,
   * so nothing needed it, and the MagicDNS name is not something an unauthenticated endpoint should
   * hand out. The node UUID and public key are deliberately NOT here either: they live on
   * `GET capabilities`, behind {@link PoolPeerGuard}. A UUID whose entire purpose is surviving
   * renames is a durable correlator, which is the last thing to publish on an open endpoint.
   *
   * `isCiHub` stays, because `listDiscoverableDevices` on every already-deployed Hub reads it.
   */
  @Get('identify')
  async identify() {
    return { isCiHub: true, poolProtocol: POOL_PROTOCOL_VERSION };
  }

  // ── Operator-facing status, settings and observability ──────────────────

  /**
   * One call answering "is pooling on, why or why not, who is in the pool, what can they serve, and
   * how loaded is everything". Safe to poll: see `HubPoolPeerService.getPoolStatus` for what it does
   * and does not touch. Peer rows come from `toPublicPeer`, so the token columns cannot leak here.
   */
  @UseGuards(AuthGuard)
  @Get('status')
  async poolStatus() {
    return { ...(await this.peerService.getPoolStatus()), routing: this.routingLog.summary() };
  }

  @UseGuards(AuthGuard)
  @Get('settings')
  async getPoolSettings() {
    return this.configuration.getHubPoolPreferences();
  }

  /**
   * Persisted pool tuning. No app restart is scheduled, unlike the inference preferences: every
   * value here is read on the Hub's own request/poll path, so it takes effect on the next request
   * without an app's environment changing.
   */
  @UseGuards(AuthGuard)
  @Patch('settings')
  async updatePoolSettings(@Body() body: UpdateHubPoolPreferencesBody) {
    return this.configuration.setHubPoolPreferences(body);
  }

  /** Recent routing decisions, newest first. Metadata only — never prompts or response bodies. */
  @UseGuards(AuthGuard)
  @Get('routing-log')
  async getPoolRoutingLog(@Query() query: RoutingLogQueryDto) {
    return { entries: this.routingLog.list(query.limit), summary: this.routingLog.summary() };
  }

  // ── Operator-facing peer management ─────────────────────────────────────

  @UseGuards(AuthGuard)
  @Get('peers')
  async listPeers() {
    return (await this.peerService.listPeers()).map(toPublicPeer);
  }

  /**
   * Pairing candidates from every source this node has, merged and deduplicated on `nodeFqdn`.
   *
   * Tailscale Admin API discovery is unchanged and still the primary source — it is what lets a pool
   * span networks. Manually probed addresses are folded in alongside it, so a node found both ways
   * is offered once.
   */
  @UseGuards(AuthGuard)
  @Get('peers/discoverable')
  async listDiscoverable() {
    return this.discoveryService.listDiscoverableNodes();
  }

  /**
   * Look up one operator-typed address and report what is there.
   *
   * This is what makes pairing possible without a Tailscale OAuth client: the operator types a LAN
   * address once and gets back the node's tailnet FQDN, which the existing `peers/pair` then uses.
   * The address itself is never stored and never becomes a transport — see
   * `HubPoolDiscoveryService`.
   */
  @UseGuards(AuthGuard)
  @Post('peers/probe')
  async probePeerAddress(@Body() body: ProbePeerAddressBody) {
    return this.discoveryService.probeAddress(body.address);
  }

  @UseGuards(AuthGuard)
  @Post('peers/pair')
  async pairPeer(@Body() body: PairPeerBody) {
    return toPublicPeer(await this.peerService.initiatePairing(body.nodeFqdn, body.displayName, body.pin));
  }

  // ── Pairing PIN and node identity (operator-facing) ──────────────────────

  /**
   * Mint a pairing PIN. THE ONLY place the digits are ever returned — `GET status` reports whether
   * one is outstanding and when it expires, never its value, so the UI can render a countdown
   * without the PIN becoming re-servable to anyone who can poll.
   */
  @UseGuards(AuthGuard)
  @Post('pairing-pin')
  async mintPairingPin() {
    const minted = this.peerService.mintPairingPin();
    // The identity summary directly, not through `getPoolStatus` — that builds this node's whole
    // model inventory, which minting a PIN has no reason to pay for.
    return { ...minted, ...(await this.peerService.identitySummary()) };
  }

  @UseGuards(AuthGuard)
  @Delete('pairing-pin')
  async cancelPairingPin() {
    this.peerService.cancelPairingPin();
    return { cancelled: true };
  }

  /** Run the bearer→signed exchange for one peer now, rather than waiting for the health poll to reach it. */
  @UseGuards(AuthGuard)
  @Post('peers/:id/upgrade')
  async upgradePeer(@Param('id') id: string) {
    return toPublicPeer(await this.peerService.upgradePeerToSigned(id));
  }

  /**
   * New keypair, same node UUID — and every peer unpaired, because they have all pinned the old key
   * and there is no signed-rotation message in this protocol. The response names the peers that
   * could not be reached, which are the ones an operator has to clear by hand on the far side.
   */
  @UseGuards(AuthGuard)
  @Post('identity/rotate')
  async rotateIdentity() {
    return this.peerService.rotateIdentity();
  }

  @UseGuards(AuthGuard)
  @Post('peers/:id/approve')
  async approvePeer(@Param('id') id: string) {
    return toPublicPeer(await this.peerService.approvePairing(id));
  }

  @UseGuards(AuthGuard)
  @Post('peers/:id/reject')
  async rejectPeer(@Param('id') id: string) {
    await this.peerService.rejectPairing(id);
    return { success: true };
  }

  /**
   * Per-peer kill switch. Two verbs rather than one PATCH carrying a boolean, matching
   * `approve`/`reject` above: the operator surfaces are all "do this to that peer", and a body with
   * a single field would be the only one in this controller.
   *
   * Reversible and symmetric — no work in either direction while disabled, but the pairing and both
   * tokens survive, so re-enabling needs no approval from the other side. Unpair is still the only
   * thing that revokes a credential.
   */
  @UseGuards(AuthGuard)
  @Post('peers/:id/enable')
  async enablePeer(@Param('id') id: string) {
    return toPublicPeer(await this.peerService.setPeerEnabled(id, true));
  }

  @UseGuards(AuthGuard)
  @Post('peers/:id/disable')
  async disablePeer(@Param('id') id: string) {
    return toPublicPeer(await this.peerService.setPeerEnabled(id, false));
  }

  @UseGuards(AuthGuard)
  @Delete('peers/:id')
  async removePeer(@Param('id') id: string) {
    await this.peerService.removePeer(id);
    return { success: true };
  }

  // ── Peer-to-peer pairing handshake (see HubPoolPeerService) ─────────────

  /**
   * The module's only unauthenticated write, and the one the PIN exists for.
   *
   * With a PIN: the identity claim is authenticated, so it is pinned, and this node answers with its
   * own identity — but the row still lands `pending`. A PIN authenticates the request; it does not
   * stand in for the operator seeing who is asking (see `receivePairingRequest`).
   * Without one: byte-for-byte today's behaviour, which is what keeps a mixed-version fleet pairing.
   */
  @Post('pair/request')
  async handlePairingRequest(@Req() req: Request, @Body() body: IncomingPairingRequestBody) {
    const identity = await this.peerService.receivePairingRequest(body.fromNodeFqdn, body.fromDisplayName, body.token, {
      fromNodeUuid: body.fromNodeUuid,
      fromPublicKey: body.fromPublicKey,
      pin: body.pin,
      // `callerSourceIp`, not `req.ip`. Behind Traefik or the Cloudflare tunnel `req.ip` is the
      // proxy, so keying the PIN cooldown on it would make a "per-source" limit global — and a
      // global lockout on this route is a denial-of-pairing primitive, not a defence. The helper
      // returns an address only when it really is the caller's; otherwise the cooldown falls back
      // to the claimed FQDN key alone and the per-PIN attempt ceiling does the rest.
      source: { ip: callerSourceIp(req) },
    });
    return { received: true, ...identity };
  }

  @UseGuards(PoolPeerGuard)
  @Post('pair/confirm')
  async handlePairingConfirm(@Req() req: Request, @Body() body: PairingConfirmBody) {
    if (!req.poolPeer) {
      throw new ForbiddenException('Pool peer not resolved');
    }
    const identity = await this.peerService.confirmPairing(req.poolPeer, body.token, {
      fromNodeUuid: body.fromNodeUuid,
      fromPublicKey: body.fromPublicKey,
    });
    return { confirmed: true, ...identity };
  }

  /**
   * Bearer→signed identity exchange, authenticated by {@link PoolPeerGuard} — i.e. by the very
   * credential it retires. This is a transfer of an existing trust relationship onto a stronger
   * carrier, not a fresh trust-on-first-use bootstrap: it is exactly as trustworthy as the pairing
   * it inherits, and no more.
   */
  @UseGuards(PoolPeerGuard)
  @Post('pair/upgrade')
  async handlePairingUpgrade(@Req() req: Request, @Body() body: PairingUpgradeBody) {
    if (!req.poolPeer) {
      throw new ForbiddenException('Pool peer not resolved');
    }
    return this.peerService.handleUpgradeRequest(req.poolPeer, { nodeUuid: body.nodeUuid, publicKey: body.publicKey });
  }

  /** Guarded like `pair/unpair`: an anonymous caller could otherwise delete any pending outbound row by naming it, and the operator would see the pairing silently disappear. */
  @UseGuards(PoolPeerGuard)
  @Post('pair/reject')
  async handlePairingReject(@Req() req: Request) {
    if (!req.poolPeer) {
      throw new ForbiddenException('Pool peer not resolved');
    }
    await this.peerService.handleRemoteReject(req.poolPeer);
    return { acknowledged: true };
  }

  /** Unpairing tears down an established pairing, so the caller must prove it holds our token. */
  @UseGuards(PoolPeerGuard)
  @Post('pair/unpair')
  async handlePairingUnpair(@Req() req: Request) {
    if (!req.poolPeer) {
      throw new ForbiddenException('Pool peer not resolved');
    }
    await this.peerService.handleRemoteUnpair(req.poolPeer);
    return { acknowledged: true };
  }

  // ── Peer-facing: this node's capabilities ───────────────────────────────

  /**
   * Branch order matters, and is fixed:
   *   1. {@link PoolPeerGuard} — is this a paired peer at all (401)?
   *   2. master kill switch — 503, so the caller's probe fails and marks this node unreachable.
   *   3. row not `connected` — 403, the half-finished-pairing case the guard deliberately admits.
   *   4. inbound off, or this peer disabled — 200 with an empty inventory and `acceptingWork: false`.
   *
   * The asymmetry between 2 and 4 is the whole design, not an oversight to tidy up later. The
   * master switch means "I have left the pool": a hard failure is correct, and the caller marking
   * this node unreachable after three strikes is documented, tested behaviour. The finer switches
   * mean "I am still in the pool, still using you, just not serving right now" — the machine is up
   * and answering, so a 503 there would show a healthy node as broken on both dashboards and cost
   * three polls to come back from.
   */
  @UseGuards(PoolPeerGuard)
  @Get('capabilities')
  async capabilities(@Req() req: Request) {
    const enabled = this.peerService.enabledState();
    if (!enabled.enabled) {
      // Answering "I have nothing" would get cached as this node's capabilities; refusing instead
      // makes the caller's health probe fail outright, which is what should mark us unreachable.
      throw new ServiceUnavailableException(describeHubPoolDisabled(enabled.disabledBy));
    }
    if (req.poolPeer?.status !== 'connected') {
      throw new ForbiddenException('Peer is not connected');
    }
    return this.peerService.getOwnCapabilities(this.peerService.inboundRefusal(req.poolPeer) === null);
  }

  // ── App-facing proxy (local Docker network apps only; PoolAppGuard additionally rejects tunnel-forwarded traffic) ──

  @UseGuards(InternalNetworkGuard, PoolAppGuard)
  @Post('v1/chat/completions')
  async proxyChatCompletions(@Body() body: Record<string, unknown>, @Res() res: Response) {
    await this.proxyToPool('/v1/chat/completions', body, res);
  }

  @UseGuards(InternalNetworkGuard, PoolAppGuard)
  @Post('v1/completions')
  async proxyCompletions(@Body() body: Record<string, unknown>, @Res() res: Response) {
    await this.proxyToPool('/v1/completions', body, res);
  }

  @UseGuards(InternalNetworkGuard, PoolAppGuard)
  @Post('v1/embeddings')
  async proxyEmbeddings(@Body() body: Record<string, unknown>, @Res() res: Response) {
    await this.proxyToPool('/v1/embeddings', body, res);
  }

  @UseGuards(InternalNetworkGuard, PoolAppGuard)
  @Post('api/generate')
  async proxyOllamaGenerate(@Body() body: Record<string, unknown>, @Res() res: Response) {
    await this.proxyToPool('/api/generate', body, res);
  }

  @UseGuards(InternalNetworkGuard, PoolAppGuard)
  @Post('api/chat')
  async proxyOllamaChat(@Body() body: Record<string, unknown>, @Res() res: Response) {
    await this.proxyToPool('/api/chat', body, res);
  }

  @UseGuards(InternalNetworkGuard, PoolAppGuard)
  @Post('api/embeddings')
  async proxyOllamaEmbeddings(@Body() body: Record<string, unknown>, @Res() res: Response) {
    await this.proxyToPool('/api/embeddings', body, res);
  }

  @UseGuards(InternalNetworkGuard, PoolAppGuard)
  @Post('api/embed')
  async proxyOllamaEmbed(@Body() body: Record<string, unknown>, @Res() res: Response) {
    await this.proxyToPool('/api/embed', body, res);
  }

  @UseGuards(InternalNetworkGuard, PoolAppGuard)
  @Get('v1/models')
  async proxyOpenAiModelsList(@Res() res: Response) {
    await this.proxyService.proxyLocalOnlyRequest('/v1/models', 'GET', undefined, res);
  }

  @UseGuards(InternalNetworkGuard, PoolAppGuard)
  @Get('api/tags')
  async proxyOllamaTags(@Res() res: Response) {
    await this.proxyService.proxyLocalOnlyRequest('/api/tags', 'GET', undefined, res);
  }

  // Ollama natives with no `model` to route on (or, for /api/show, nothing worth routing): served
  // by this node's own engine so an app pointed at OLLAMA_HOST doesn't get a 404 from the proxy.
  @UseGuards(InternalNetworkGuard, PoolAppGuard)
  @Get('api/ps')
  async proxyOllamaPs(@Res() res: Response) {
    await this.proxyService.proxyLocalOnlyRequest('/api/ps', 'GET', undefined, res);
  }

  @UseGuards(InternalNetworkGuard, PoolAppGuard)
  @Get('api/version')
  async proxyOllamaVersion(@Res() res: Response) {
    await this.proxyService.proxyLocalOnlyRequest('/api/version', 'GET', undefined, res);
  }

  @UseGuards(InternalNetworkGuard, PoolAppGuard)
  @Post('api/show')
  async proxyOllamaShow(@Body() body: Record<string, unknown>, @Res() res: Response) {
    await this.proxyService.proxyLocalOnlyRequest('/api/show', 'POST', body, res);
  }

  private async proxyToPool(path: string, body: Record<string, unknown>, res: Response): Promise<void> {
    const model = typeof body?.model === 'string' ? body.model : undefined;
    if (!model) {
      res.status(400).json({ error: 'Request body must include a "model" field' });
      return;
    }
    await this.proxyService.proxyRequest({ path, method: 'POST', body, model, res });
  }

  // ── Peer-facing local forward (PoolPeerGuard: paired peers only, never re-selects candidates) ──

  @UseGuards(PoolPeerGuard)
  @Post('local/v1/chat/completions')
  async localChatCompletions(@Req() req: Request, @Body() body: Record<string, unknown>, @Res() res: Response) {
    await this.forwardLocal(req, '/v1/chat/completions', 'POST', body, res);
  }

  @UseGuards(PoolPeerGuard)
  @Post('local/v1/completions')
  async localCompletions(@Req() req: Request, @Body() body: Record<string, unknown>, @Res() res: Response) {
    await this.forwardLocal(req, '/v1/completions', 'POST', body, res);
  }

  @UseGuards(PoolPeerGuard)
  @Post('local/v1/embeddings')
  async localEmbeddings(@Req() req: Request, @Body() body: Record<string, unknown>, @Res() res: Response) {
    await this.forwardLocal(req, '/v1/embeddings', 'POST', body, res);
  }

  @UseGuards(PoolPeerGuard)
  @Post('local/api/generate')
  async localOllamaGenerate(@Req() req: Request, @Body() body: Record<string, unknown>, @Res() res: Response) {
    await this.forwardLocal(req, '/api/generate', 'POST', body, res);
  }

  @UseGuards(PoolPeerGuard)
  @Post('local/api/chat')
  async localOllamaChat(@Req() req: Request, @Body() body: Record<string, unknown>, @Res() res: Response) {
    await this.forwardLocal(req, '/api/chat', 'POST', body, res);
  }

  @UseGuards(PoolPeerGuard)
  @Post('local/api/embeddings')
  async localOllamaEmbeddings(@Req() req: Request, @Body() body: Record<string, unknown>, @Res() res: Response) {
    await this.forwardLocal(req, '/api/embeddings', 'POST', body, res);
  }

  @UseGuards(PoolPeerGuard)
  @Post('local/api/embed')
  async localOllamaEmbed(@Req() req: Request, @Body() body: Record<string, unknown>, @Res() res: Response) {
    await this.forwardLocal(req, '/api/embed', 'POST', body, res);
  }

  @UseGuards(PoolPeerGuard)
  @Get('local/v1/models')
  async localOpenAiModels(@Req() req: Request, @Res() res: Response) {
    await this.forwardLocal(req, '/v1/models', 'GET', undefined, res);
  }

  @UseGuards(PoolPeerGuard)
  @Get('local/api/tags')
  async localOllamaTags(@Req() req: Request, @Res() res: Response) {
    await this.forwardLocal(req, '/api/tags', 'GET', undefined, res);
  }

  private async forwardLocal(req: Request, path: string, method: string, body: unknown, res: Response): Promise<void> {
    const peer = req.poolPeer;
    if (!peer || peer.status !== 'connected') {
      this.proxyService.recordRefusedInboundForward({ backend: null, path, fromPeerFqdn: peer?.nodeFqdn, status: 403 });
      res.status(403).json({ error: 'Peer is not connected' });
      return;
    }
    // The capabilities probe already told this peer we are not accepting work, but it may be acting
    // on a snapshot up to one poll old — this covers that window.
    //
    // 503, never 403: `shouldFailover` treats >= 500 as retryable, so the sender simply moves to its
    // next candidate, whereas `noteRejectedCandidate` reads 401/403 as "it no longer considers us
    // paired" and drops the peer's cached capabilities. Answering 403 for a temporary local policy
    // decision would make a healthy pairing repeatedly invalidate itself.
    const refusal = this.peerService.inboundRefusal(peer);
    if (refusal) {
      this.proxyService.recordRefusedInboundForward({ backend: null, path, fromPeerFqdn: peer.nodeFqdn, status: 503 });
      res.status(503).json({ error: describeHubPoolInboundRefused(refusal) });
      return;
    }
    const backendHeader = req.header('x-hub-pool-backend');
    const backend = (INFERENCE_BACKEND_TYPES as readonly string[]).includes(backendHeader ?? '')
      ? (backendHeader as InferenceBackendType)
      : undefined;
    if (!backend) {
      res.status(400).json({ error: 'Missing or invalid X-Hub-Pool-Backend header' });
      return;
    }
    // Unlike the backend header this is advisory: it only attributes the serving outcome to a
    // model, so an absent or bogus value costs a strike, never the forward.
    const model = req.header('x-hub-pool-model') || undefined;
    // The peer's FQDN comes from its `hub_pool_peer` row, not the caller-supplied header, so the
    // routing log records who the guard actually authenticated rather than who claimed to call.
    await this.proxyService.forwardToLocalBackendAndRespond(backend, path, method, body, res, peer.nodeFqdn, model);
  }
}
