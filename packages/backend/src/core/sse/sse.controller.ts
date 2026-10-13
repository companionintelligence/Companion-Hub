import { TranslatableError } from '@/common/error/translatable-error';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { settingsReadAction } from '@/core/portal/local-app-reads';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { HubManagerGuard } from '@/modules/auth/hub-manager.guard';
import { Controller, HttpStatus, type MessageEvent, Query, Req, Sse, UseGuards } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { StreamAppLogsQueryDto, StreamHubLogsQueryDto, logStreamLines } from './dto/sse.dto';
import { SSEService } from './sse.service';

@UseGuards(AuthGuard)
@Controller('sse')
export class SSEController {
  constructor(
    private readonly sseService: SSEService,
    private readonly moduleRef: ModuleRef,
  ) {}

  @Sse('app')
  appEvents(): Observable<MessageEvent> {
    return this.sseService.getAppEventsObservable();
  }

  /**
   * One app's container logs. They carry what its settings do (env values a container prints at
   * start), so reading them takes the verb reading its settings takes (`settingsReadAction`):
   * `configure` on a custom app, `view` on a catalog app, as for `compose-diff`.
   */
  @Sse('app-logs')
  async appLogsEvents(@Query() query: StreamAppLogsQueryDto, @Req() req: Request): Promise<Observable<MessageEvent>> {
    const appUrn = castAppUrn(query.appUrn);
    const whois = this.resolveWhois();

    if (!whois) {
      throw new TranslatableError('APP_ACTION_GRANT_DENIED', { action: settingsReadAction(appUrn) }, HttpStatus.FORBIDDEN);
    }

    await whois.assertSessionAction(req, appUrn, settingsReadAction(appUrn));

    return this.sseService.getLogStreamObservable('app-logs', logStreamLines(query.maxLines), appUrn);
  }

  /** The Hub's own log, an owner's or admin's to read (`HubManagerGuard`). */
  @Sse('ci-hub-logs')
  @UseGuards(HubManagerGuard)
  async hubLogsEvents(@Query() query: StreamHubLogsQueryDto): Promise<Observable<MessageEvent>> {
    return this.sseService.getLogStreamObservable('ci-hub-logs', logStreamLines(query.maxLines));
  }

  /** Resolved when asked, as `HubManagerGuard` resolves it, so this module needn't import the Portal module. */
  private resolveWhois(): MarketplaceWhoIsService | null {
    try {
      return this.moduleRef.get(MarketplaceWhoIsService, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }
}
