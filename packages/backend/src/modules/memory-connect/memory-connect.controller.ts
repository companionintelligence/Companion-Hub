import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AppUrn } from '@ci-hub/common/types';
import { LoggerService } from '@/core/logger/logger.service';
import { AuthGuard } from '../auth/auth.guard';
import { InternalNetworkGuard } from '../auth/internal-network.guard';
import { MemoryConnectService } from './memory-connect.service';

/**
 * Endpoints backing the memory-connect flow.
 *
 *   GET  /api/memory-connect/start            → browser: begin connect (→ ci-memory consent)
 *   GET  /api/memory-connect/callback         → browser: return from ci-memory, apply, redirect to `next`
 *   GET  /api/memory-connect/apps/:urn/state  → wrapper: {state, connectUrl} (internal network)
 *   POST /api/memory-connect/apps/:urn/skip   → wrapper: mark skipped (internal network)
 *   POST /api/memory-connect/apps/:urn/disconnect → browser: revoke + clear + restart
 *
 * Browser routes are session-guarded (the user is signed into the Hub); the
 * wrapper-facing state/skip routes are reachable only from the internal docker
 * network (the app wrapper calls the Hub at CI_HUB_URL).
 */
@Controller('memory-connect')
export class MemoryConnectController {
  constructor(
    private readonly service: MemoryConnectService,
    private readonly logger: LoggerService,
  ) {}

  @UseGuards(AuthGuard)
  @Get('start')
  async start(@Query('app') app: string | undefined, @Query('next') next: string | undefined, @Res() res: Response): Promise<void> {
    if (!app) {
      throw new BadRequestException('app is required');
    }

    // `next` is validated server-side in startConnect (origin-allowlisted against
    // the Hub + the connecting app), so an attacker can't use it as an open redirect.
    const consentUrl = await this.service.startConnect(app as AppUrn, next);
    res.redirect(consentUrl);
  }

  @UseGuards(AuthGuard)
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // The user denied consent on ci-memory (or an upstream error) — return to
    // the dashboard rather than dead-ending; nothing was minted.
    if (error || !code || !state) {
      this.logger.warn(`[MemoryConnect] callback without a usable code (error=${error ?? 'none'})`);
      res.redirect('/');

      return;
    }

    try {
      const { next } = await this.service.handleCallback(code, state);
      res.redirect(next);
    } catch (err) {
      this.logger.error('[MemoryConnect] callback failed', err);
      res.redirect('/?memoryConnect=error');
    }
  }

  @UseGuards(InternalNetworkGuard)
  @Get('apps/:urn/state')
  async state(@Param('urn') urn: string) {
    return this.service.getStatus(this.decodeUrn(urn));
  }

  @UseGuards(AuthGuard)
  @Get('apps/:urn/status')
  async status(@Param('urn') urn: string) {
    return this.service.getUiStatus(this.decodeUrn(urn));
  }

  @UseGuards(InternalNetworkGuard)
  @Post('apps/:urn/skip')
  async skip(@Param('urn') urn: string) {
    await this.service.skip(this.decodeUrn(urn));

    return { ok: true };
  }

  @UseGuards(AuthGuard)
  @Post('apps/:urn/disconnect')
  async disconnect(@Param('urn') urn: string, @Req() _req: Request, @Body() _body: unknown) {
    await this.service.disconnect(this.decodeUrn(urn));

    return { ok: true };
  }

  /** URNs contain a colon and may arrive percent-encoded. */
  private decodeUrn(urn: string): AppUrn {
    return decodeURIComponent(urn) as AppUrn;
  }
}
