import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import type { InferenceBackendType } from '@ci-hub/common/types';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { InternalNetworkGuard } from '@/modules/auth/internal-network.guard';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { isHubPoolEnabled } from '@/common/helpers/hub-pool';
import { PoolAppGuard } from './guards/pool-app.guard';
import { PoolPeerGuard } from './guards/pool-peer.guard';
import { HubPoolPeerService } from './hub-pool-peer.service';
import { ALL_BACKEND_TYPES, PoolProxyService } from './hub-pool-proxy.service';
import { IncomingPairingRequestBody, PairingConfirmBody, PairPeerBody } from './hub-pool.dto';
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
    private readonly tailscaleService: TailscaleService,
  ) {}

  // ── Discovery / identification ──────────────────────────────────────────

  @Get('identify')
  async identify() {
    const status = await this.tailscaleService.getStatusCached();
    return { isCiHub: true, nodeFqdn: status.nodeFqdn };
  }

  // ── Operator-facing peer management ─────────────────────────────────────

  @UseGuards(AuthGuard)
  @Get('peers')
  async listPeers() {
    return (await this.peerService.listPeers()).map(toPublicPeer);
  }

  @UseGuards(AuthGuard)
  @Get('peers/discoverable')
  async listDiscoverable() {
    return this.peerService.listDiscoverableDevices();
  }

  @UseGuards(AuthGuard)
  @Post('peers/pair')
  async pairPeer(@Body() body: PairPeerBody) {
    return toPublicPeer(await this.peerService.initiatePairing(body.nodeFqdn, body.displayName));
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

  @UseGuards(AuthGuard)
  @Delete('peers/:id')
  async removePeer(@Param('id') id: string) {
    await this.peerService.removePeer(id);
    return { success: true };
  }

  // ── Peer-to-peer pairing handshake (see HubPoolPeerService) ─────────────

  @Post('pair/request')
  async handlePairingRequest(@Body() body: IncomingPairingRequestBody) {
    await this.peerService.receivePairingRequest(body.fromNodeFqdn, body.fromDisplayName, body.token);
    return { received: true };
  }

  @UseGuards(PoolPeerGuard)
  @Post('pair/confirm')
  async handlePairingConfirm(@Req() req: Request, @Body() body: PairingConfirmBody) {
    if (!req.poolPeer) {
      throw new ForbiddenException('Pool peer not resolved');
    }
    await this.peerService.confirmPairing(req.poolPeer, body.token);
    return { confirmed: true };
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

  @UseGuards(PoolPeerGuard)
  @Get('capabilities')
  async capabilities(@Req() req: Request) {
    if (!isHubPoolEnabled()) {
      // Answering "I have nothing" would get cached as this node's capabilities; refusing instead
      // makes the caller's health probe fail outright, which is what should mark us unreachable.
      throw new ServiceUnavailableException('Hub pooling is disabled on this node (HUB_POOL_USER_DISABLED)');
    }
    if (req.poolPeer?.status !== 'connected') {
      throw new ForbiddenException('Peer is not connected');
    }
    return this.peerService.getOwnCapabilities();
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
      res.status(403).json({ error: 'Peer is not connected' });
      return;
    }
    const backendHeader = req.header('x-hub-pool-backend');
    const backend = (ALL_BACKEND_TYPES as string[]).includes(backendHeader ?? '') ? (backendHeader as InferenceBackendType) : undefined;
    if (!backend) {
      res.status(400).json({ error: 'Missing or invalid X-Hub-Pool-Backend header' });
      return;
    }
    await this.proxyService.forwardToLocalBackendAndRespond(backend, path, method, body, res);
  }
}
