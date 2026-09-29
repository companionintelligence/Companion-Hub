import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Optional,
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
import { ModuleRef } from '@nestjs/core';
import { ApiTags } from '@nestjs/swagger';
import { INFERENCE_BACKEND_TYPES, type InferenceBackendType } from '@ci-hub/common/types';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { InferenceAccessGuard } from '@/modules/auth/inference-access.guard';
import { ObservabilityRead, ObservabilityReadGuard } from '@/modules/auth/observability-read.guard';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { callerSourceIp, describeHubPoolDisabled, describeHubPoolInboundRefused } from '@/common/helpers/hub-pool';
import { INFERENCE_ENV_REFRESHER, type InferenceEnvRefresher } from '@/common/helpers/inference-env-refresh';
import { PoolPeerGuard } from './guards/pool-peer.guard';
import { HubPoolPeerService } from './hub-pool-peer.service';
import { HubPoolRoutingLogService } from './hub-pool-routing-log.service';
import { POOL_REQUEST_ID_HEADER, PoolProxyService, normalizePoolRequestId } from './hub-pool-proxy.service';
import { POOL_SESSION_HEADER } from './hub-pool-prefix-affinity';
import { HubPoolDiscoveryService } from './hub-pool-discovery.service';
import { HubPoolPinService } from './hub-pool-pin.service';
import {
  DeletePoolPinQuery,
  IncomingPairingRequestBody,
  PairingConfirmBody,
  PairingUpgradeBody,
  PairPeerBody,
  ProbePeerAddressBody,
  RoutingLogQueryDto,
  UpdateHubPoolPreferencesBody,
  UpsertPoolPinBody,
} from './hub-pool.dto';
import { POOL_PROTOCOL_VERSION } from './hub-pool-peer-auth';
import { isPairingIncomplete, toPublicPeer } from './hub-pool.types';

/**
 * Multi-Hub inference pooling.
 *
 * `peers/*` and `pair/*` are the pairing lifecycle (see `HubPoolPeerService`
 * doc comment for the token model). `v1/*` and `api/*` are app-facing —
 * guarded by {@link InferenceAccessGuard}, which admits a request that
 * originated inside the appliance by origin alone and one that reached the Hub
 * through the public tunnel only with an `inference` API key — and run full
 * candidate selection + failover. `local/*` are peer-facing — guarded by
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
    // Appended after `discoveryService` for the same reason it was: every pool test file constructs
    // this controller positionally.
    private readonly pinService: HubPoolPinService,
    // Appended last for the same reason. Only used to reach INFERENCE_ENV_REFRESHER, and optional so
    // those positional harnesses keep constructing this controller.
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  // ── Discovery / identification ──────────────────────────────────────────

  /**
   * The only unauthenticated route in the module that is not a write, and the only one published
   * through the Cloudflare tunnel.
   *
   * It answers exactly two things: that this is a CI-Hub, and which pool protocol it speaks.
   * `nodeFqdn` used to be here and has been removed: the MagicDNS name is not something an endpoint
   * on the open internet should hand out. The node UUID and public key are deliberately NOT here
   * either — they live on `GET capabilities`, behind {@link PoolPeerGuard}. A UUID whose entire
   * purpose is surviving renames is a durable correlator, which is the last thing to publish on an
   * open endpoint.
   *
   * The name is not simply gone, though: `POST peers/probe` needs it to be *learnable*, or pairing
   * by address cannot work at all. It is disclosed in the reply to a `pair/request` that carried a
   * valid pairing PIN — i.e. to a caller that has demonstrably been in front of this Hub's screen.
   * That is the boundary the trim moved the name behind, not a deletion.
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
   *
   * Readable by a `qa:read` key, and by the CLI JWT on a Hub nobody has claimed — see
   * `ObservabilityReadGuard` for why that second one is safe.
   */
  @UseGuards(ObservabilityReadGuard)
  @ObservabilityRead({ unclaimedCli: true })
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
   * Persisted pool tuning. Almost every value here is read on the Hub's own request/poll path, so it
   * takes effect on the next request without an app's environment changing.
   *
   * The master and outbound switches are the exception. AI apps are handed their chat model from
   * what the pool serves, so switching either one changes that answer: master off repoints apps at
   * a direct backend, and outbound off drops every peer's models from the inventory. This is the
   * route Settings > Network > Hub Pool saves those switches through, so it asks for the same AI app
   * refresh the inference preference routes do. Without it the change reached apps only through the
   * membership watcher, a minute later, and as an automatic refresh that declines to restart an app
   * into a config with no model, which is exactly what switching the pool off can produce.
   */
  @UseGuards(AuthGuard)
  @Patch('settings')
  async updatePoolSettings(@Body() body: UpdateHubPoolPreferencesBody) {
    const before = this.configuration.getHubPoolPreferences();
    const after = await this.configuration.setHubPoolPreferences(body);
    const moved = (['poolEnabled', 'poolOutboundEnabled'] as const).filter((key) => body[key] !== undefined && before?.[key] !== after?.[key]);
    if (moved.length > 0) {
      this.requestInferenceRefresh(`pool settings changed: ${moved.join(', ')}`);
    }
    return after;
  }

  private requestInferenceRefresh(reason: string): void {
    let refresher: InferenceEnvRefresher | undefined;
    try {
      refresher = this.moduleRef?.get<InferenceEnvRefresher>(INFERENCE_ENV_REFRESHER, { strict: false });
    } catch {
      // ModuleRef.get throws on an unresolvable token. The membership watcher still sees the switch
      // on its next two polls, so apps are refreshed later rather than never.
    }
    refresher?.requestRefresh(reason);
  }

  /**
   * Recent routing decisions, newest first. Metadata only — never prompts or response bodies.
   *
   * `?since=` turns this into a cursor: pass back the `nextSince` of the previous call and get only
   * the rows placed or changed since, so a poller neither re-reads the ring nor misses a row that was
   * `pending` last time. `matched > entries.length` says the page was cut by `limit`; `summary.bootId`
   * changing says the Hub restarted and the old cursor points into a log that no longer exists.
   * Readable by the same credentials as `status`.
   */
  @UseGuards(ObservabilityReadGuard)
  @ObservabilityRead({ unclaimedCli: true })
  @Get('routing-log')
  async getPoolRoutingLog(@Query() query: RoutingLogQueryDto) {
    const page = this.routingLog.query({ limit: query.limit, since: query.since });
    return { entries: page.entries, summary: this.routingLog.summary(), matched: page.matched, nextSince: page.nextSince };
  }

  // ── Operator-facing routing pins ────────────────────────────────────────

  /**
   * Add or replace a routing pin.
   *
   * Upsert by POST, because `(scope, model)` is the key an operator edits and a pin has no id — pins
   * live in settings.json, not in a table. There is no GET: `/status` reports every pin with its
   * target resolved and `targetAvailable` computed, which is the form anything rendering them needs.
   *
   * Takes effect on the very next pooled request, like every other pool setting, with no app restart.
   */
  @UseGuards(AuthGuard)
  @Post('pins')
  async upsertPoolPin(@Body() body: UpsertPoolPinBody) {
    return { pins: await this.pinService.upsert(body) };
  }

  /**
   * Remove a routing pin, addressed by `?scope=` (+ `?model=` for a model pin).
   *
   * Query rather than a path parameter because model ids contain `/` and `:`, which Nest would split
   * a path param on. Removing a pin that is not there succeeds: the operator asked for a state, and
   * that state now holds.
   */
  @UseGuards(AuthGuard)
  @Delete('pins')
  async deletePoolPin(@Query() query: DeletePoolPinQuery) {
    return { pins: await this.pinService.remove(query.scope, query.model) };
  }

  // ── Operator-facing peer management ─────────────────────────────────────

  /**
   * The peer rows themselves. `containers` and `maxNumCtx` are added alongside each row rather than
   * left to be read out of `lastCapabilities`: that column is free-form jsonb the peer writes, so
   * the clamped value is the only one a caller may render. `containers: null` means "not reported" —
   * an older peer, an operator who opted out, or a snapshot too old to believe — and never 0.
   *
   * `maxNumCtx` is here and not only on `/pool/status` because a context cap is now an input to
   * placement (`applyContextCap`), and `cihub pool peers` is where an operator lists the fleet. A
   * cap nobody can see is one that silently drops a node out of eligibility for large windows.
   * `null` is "no cap advertised", which routing reads as "takes any window" — never as a default.
   */
  @UseGuards(AuthGuard)
  @Get('peers')
  async listPeers() {
    return (await this.peerService.listPeers()).map((peer) => ({
      ...toPublicPeer(peer),
      containers: this.peerService.peerContainers(peer),
      maxNumCtx: this.peerService.peerContextCap(peer),
    }));
  }

  /**
   * Pairing candidates this node can offer **by name**, from every directory that can attest one,
   * deduplicated: the tailnet (the local Tailscale daemon's peer map, plus the Admin API when a
   * credential is configured) and the CI Portal device registry when this Hub is registered.
   * Neither is required, and a Hub with neither returns an empty list rather than an error.
   *
   * A Hub found by address is not in here and cannot be: entries are consumed by handing `nodeFqdn`
   * to `peers/pair`, and the unauthenticated probe is told no name. Those are paired with through
   * `peers/pair` in its address form instead. See `HubPoolDiscoveryService`.
   *
   * The exception: with LAN discovery (`poolMdnsEnabled`) on, Hubs heard over mDNS follow the
   * attested rows as `verified: false`. Those are for display only — every field came from an
   * unauthenticated datagram — and a client must never post one to `peers/pair`.
   *
   * Not a polling route. Every source probes: one `/identify` per unpaired candidate, plus a Portal
   * dispatch call and, with a credential, a Tailscale OAuth exchange.
   */
  @UseGuards(AuthGuard)
  @Get('peers/discoverable')
  async listDiscoverable() {
    return this.discoveryService.listDiscoverableNodes();
  }

  /**
   * Ask one operator-typed address what is there.
   *
   * A diagnostic, not a directory lookup: it reports reachable / is-a-CI-Hub / which pool protocol,
   * because that is everything `GET identify` will tell an unauthenticated caller. It deliberately
   * does not name the node — see `identify` above for why — so the operator's next step is to mint a
   * PIN on that Hub and `POST peers/pair { address, pin }`, which is where the name is learned.
   */
  @UseGuards(AuthGuard)
  @Post('peers/probe')
  async probePeerAddress(@Body() body: ProbePeerAddressBody) {
    return this.discoveryService.probeAddress(body.address);
  }

  /**
   * Start pairing, by tailnet name or by address.
   *
   * The two differ in where the peer's name comes from, and that is the whole distinction: a
   * `nodeFqdn` was attested by the tailnet control plane before this Hub ever dialled anything,
   * while an `address` is only a way to reach the handshake — the name arrives in the far side's
   * reply to a request carrying the PIN minted on its own screen. The DTO enforces exactly one of
   * the two, and a PIN alongside `address`.
   */
  @UseGuards(AuthGuard)
  @Post('peers/pair')
  async pairPeer(@Body() body: PairPeerBody) {
    const peer = body.address
      ? await this.discoveryService.pairAtAddress(body.address, body.displayName, body.pin as string)
      : await this.peerService.initiatePairing(body.nodeFqdn as string, body.displayName, body.pin);
    return toPublicPeer(peer);
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
   *   3. pairing incomplete — 403, the half-finished-pairing case the guard deliberately admits.
   *   4. inbound off, or this peer disabled — 200 with an empty inventory and `acceptingWork: false`.
   *
   * Branch 3 asks {@link isPairingIncomplete}, NOT `status !== 'connected'`. This route is the one
   * recovery path out of `'unreachable'`, so refusing a peer we currently believe is down makes
   * two simultaneously-unreachable nodes refuse each other forever — see that helper for the full
   * deadlock. Whether the caller is up is settled by the fact that it is calling.
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
    // Bound to a local so the peer is narrowed for `inboundRefusal` below: `isPairingIncomplete`
    // returns a plain boolean, unlike the `?.status !== 'connected'` comparison it replaced, which
    // narrowed `req.poolPeer` as a side effect of how it read an undefined peer.
    const peer = req.poolPeer;
    if (!peer || isPairingIncomplete(peer.status)) {
      throw new ForbiddenException('Peer is not connected');
    }
    return this.peerService.getOwnCapabilities(this.peerService.inboundRefusal(peer) === null);
  }

  // ── App-facing proxy (InferenceAccessGuard: apps inside the appliance by origin; editors and SDKs anywhere with an `inference` key) ──

  @UseGuards(InferenceAccessGuard)
  @Post('v1/chat/completions')
  async proxyChatCompletions(@Body() body: Record<string, unknown>, @Res() res: Response, @Headers(POOL_SESSION_HEADER) session?: string | string[]) {
    await this.proxyToPool('/v1/chat/completions', body, res, session);
  }

  @UseGuards(InferenceAccessGuard)
  @Post('v1/completions')
  async proxyCompletions(@Body() body: Record<string, unknown>, @Res() res: Response, @Headers(POOL_SESSION_HEADER) session?: string | string[]) {
    await this.proxyToPool('/v1/completions', body, res, session);
  }

  @UseGuards(InferenceAccessGuard)
  @Post('v1/embeddings')
  async proxyEmbeddings(@Body() body: Record<string, unknown>, @Res() res: Response, @Headers(POOL_SESSION_HEADER) session?: string | string[]) {
    await this.proxyToPool('/v1/embeddings', body, res, session);
  }

  @UseGuards(InferenceAccessGuard)
  @Post('api/generate')
  async proxyOllamaGenerate(@Body() body: Record<string, unknown>, @Res() res: Response, @Headers(POOL_SESSION_HEADER) session?: string | string[]) {
    await this.proxyToPool('/api/generate', body, res, session);
  }

  @UseGuards(InferenceAccessGuard)
  @Post('api/chat')
  async proxyOllamaChat(@Body() body: Record<string, unknown>, @Res() res: Response, @Headers(POOL_SESSION_HEADER) session?: string | string[]) {
    await this.proxyToPool('/api/chat', body, res, session);
  }

  @UseGuards(InferenceAccessGuard)
  @Post('api/embeddings')
  async proxyOllamaEmbeddings(
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
    @Headers(POOL_SESSION_HEADER) session?: string | string[],
  ) {
    await this.proxyToPool('/api/embeddings', body, res, session);
  }

  @UseGuards(InferenceAccessGuard)
  @Post('api/embed')
  async proxyOllamaEmbed(@Body() body: Record<string, unknown>, @Res() res: Response, @Headers(POOL_SESSION_HEADER) session?: string | string[]) {
    await this.proxyToPool('/api/embed', body, res, session);
  }

  @UseGuards(InferenceAccessGuard)
  @Get('v1/models')
  async proxyOpenAiModelsList(@Res() res: Response) {
    await this.proxyService.proxyLocalOnlyRequest('/v1/models', 'GET', undefined, res);
  }

  @UseGuards(InferenceAccessGuard)
  @Get('api/tags')
  async proxyOllamaTags(@Res() res: Response) {
    await this.proxyService.proxyLocalOnlyRequest('/api/tags', 'GET', undefined, res);
  }

  // Ollama natives with no `model` to route on (or, for /api/show, nothing worth routing): served
  // by this node's own engine so an app pointed at OLLAMA_HOST doesn't get a 404 from the proxy.
  // /api/show falls back to a peer that holds the model when no local engine does — see
  // `PoolProxyService.describeFromPeer`.
  @UseGuards(InferenceAccessGuard)
  @Get('api/ps')
  async proxyOllamaPs(@Res() res: Response) {
    await this.proxyService.proxyLocalOnlyRequest('/api/ps', 'GET', undefined, res);
  }

  @UseGuards(InferenceAccessGuard)
  @Get('api/version')
  async proxyOllamaVersion(@Res() res: Response) {
    await this.proxyService.proxyLocalOnlyRequest('/api/version', 'GET', undefined, res);
  }

  @UseGuards(InferenceAccessGuard)
  @Post('api/show')
  async proxyOllamaShow(@Body() body: Record<string, unknown>, @Res() res: Response) {
    await this.proxyService.proxyLocalOnlyRequest('/api/show', 'POST', body, res);
  }

  /**
   * `session` is the app's `X-Hub-Pool-Session` header, read on every routed POST so an app that
   * names its session gets prefix affinity for it (see `hub-pool-prefix-affinity.ts`). Passed through
   * untouched — the proxy normalises it — and ignored on a route affinity does not judge.
   */
  private async proxyToPool(path: string, body: Record<string, unknown>, res: Response, session?: string | string[]): Promise<void> {
    const model = typeof body?.model === 'string' ? body.model : undefined;
    if (!model) {
      res.status(400).json({ error: 'Request body must include a "model" field' });
      return;
    }
    await this.proxyService.proxyRequest({ path, method: 'POST', body, model, res, sessionHeader: session });
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

  // A model-metadata lookup, not a turn: the sender calls it only once none of its own engines could
  // describe the model — in practice, one its `auto` resolved to that only this node holds.
  @UseGuards(PoolPeerGuard)
  @Post('local/api/show')
  async localOllamaShow(@Req() req: Request, @Body() body: Record<string, unknown>, @Res() res: Response) {
    await this.forwardLocal(req, '/api/show', 'POST', body, res);
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
    // Read before any refusal, so a refused forward joins to the sender's failover row by id too.
    const requestId = normalizePoolRequestId(req.header(POOL_REQUEST_ID_HEADER));
    // `isPairingIncomplete`, not `status !== 'connected'`: a peer we have marked unreachable is
    // still paired, and 403 here is read by the sender's `noteRejectedCandidate` as "it no longer
    // considers us paired", dropping a valid pairing's cached capabilities over our own stale
    // outbound health opinion. Only a pairing that was never completed has nothing to serve.
    if (!peer || isPairingIncomplete(peer.status)) {
      this.proxyService.recordRefusedInboundForward({ backend: null, path, fromPeerFqdn: peer?.nodeFqdn, status: 403, requestId });
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
      this.proxyService.recordRefusedInboundForward({ backend: null, path, fromPeerFqdn: peer.nodeFqdn, status: 503, requestId });
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
    await this.proxyService.forwardToLocalBackendAndRespond(backend, path, method, body, res, peer.nodeFqdn, model, requestId);
  }
}
