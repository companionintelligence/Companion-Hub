import { LoggerService } from '@/core/logger/logger.service';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { HUB_RUNTIME_URN } from '@/modules/apps/app-runtime-monitor.service';
import { DockerService } from '@/modules/docker/docker.service';
import { ApiQuery, ApiResponse } from '@nestjs/swagger';
import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { AuthGuard } from '../auth/auth.guard';
import { HubManagerGuard } from '../auth/hub-manager.guard';
import { LoadDto, SystemResourcesDto, HostTelemetryHistoryDto, HostEventLogDto } from './dto/system.dto';
import { ResourceAllocatorService } from './resource-allocator.service';
import { SystemService } from './system.service';
import { HostTelemetryService } from './host-telemetry.service';

const isExpectedDownloadAbortError = (error: unknown) => {
  if (!(error instanceof Error) || !('code' in error)) {
    return false;
  }

  return error.code === 'ERR_STREAM_PREMATURE_CLOSE' || error.code === 'ECONNRESET' || error.code === 'EPIPE';
};

@Controller('system')
export class SystemController {
  constructor(
    private readonly systemService: SystemService,
    private readonly dockerService: DockerService,
    private readonly resourceAllocator: ResourceAllocatorService,
    private readonly hostTelemetry: HostTelemetryService,
    private readonly logger: LoggerService,
    private readonly whois: MarketplaceWhoIsService,
  ) {}

  @UseGuards(AuthGuard)
  @Get('/load')
  @ApiResponse({ type: LoadDto })
  async systemLoad() {
    const res = await this.systemService.getSystemLoad();
    return LoadDto.parse(res, { reportOnly: true });
  }

  @UseGuards(AuthGuard)
  @Get('/resources')
  @ApiResponse({ type: SystemResourcesDto })
  async systemResources() {
    const res = await this.resourceAllocator.getResourceOverview();
    return SystemResourcesDto.parse(res, { reportOnly: true });
  }

  @UseGuards(AuthGuard)
  @Get('/telemetry')
  @ApiQuery({
    name: 'minutes',
    required: false,
    type: Number,
    description: 'Host CPU and memory over this many minutes, averaged to at most 360 points. Without it, the newest 288 raw samples.',
  })
  @ApiResponse({ type: HostTelemetryHistoryDto })
  async hostTelemetryHistory(@Req() req: Request, @Query('minutes') minutes?: string) {
    if (minutes !== undefined && minutes !== '') {
      const window = await this.hostTelemetry.getWindow(Number(minutes));
      return HostTelemetryHistoryDto.parse(
        { samples: window.points, minutes: window.minutes, bucketSeconds: window.bucketSeconds },
        { reportOnly: true },
      );
    }
    // Raw rows carry every app's CPU and memory. Filter them by the same view check as
    // `GET /apps/resource-monitor`, so this route can't show a member an app Home hides.
    const samples = await this.hostTelemetry.getRecentSamples();
    const urns = [...new Set(samples.flatMap((sample) => (sample.apps ?? []).map((app) => app.appUrn)))];
    const visible = new Set(await this.whois.filterSessionByView(req, urns, (urn) => (urn === HUB_RUNTIME_URN ? undefined : urn), 'hub'));
    const filtered = samples.map((sample) => (sample.apps ? { ...sample, apps: sample.apps.filter((app) => visible.has(app.appUrn)) } : sample));
    return HostTelemetryHistoryDto.parse({ samples: filtered }, { reportOnly: true });
  }

  @UseGuards(AuthGuard)
  @Get('/events')
  @ApiResponse({ type: HostEventLogDto })
  async hostEventLog() {
    const events = await this.hostTelemetry.getRecentEvents();
    return HostEventLogDto.parse({ events }, { reportOnly: true });
  }

  @UseGuards(AuthGuard, HubManagerGuard)
  @Get('/logs/download')
  @ApiResponse({ status: 200, description: 'Hub logs download' })
  async downloadHubLogs(@Res() res: Response) {
    // @Res() bypasses NestJS exception filters, so errors must be caught
    // manually. Without this, unhandled throws propagate to Express's error
    // handler chain where @nestjs/serve-static converts them into 404s.
    let stdout: NodeJS.ReadableStream;
    let stderr: NodeJS.ReadableStream;
    let kill: () => void;

    try {
      ({ stdout, stderr, kill } = await this.dockerService.getLogsDownloadStream());
    } catch (error) {
      this.logger.error('Failed to start log download stream', error);
      res.status(500).json({ statusCode: 500, message: 'Failed to start log download stream' });
      return;
    }

    const timestamp = new Date().toISOString().replaceAll(':', '-');
    let cleanedUp = false;

    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      kill();
    };

    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="ci-hub-logs-${timestamp}.log"`,
    });

    stderr.on('data', (data: Buffer | string) => {
      const message = String(data).trim();
      if (message) {
        this.logger.warn('Hub log download stderr:', message);
      }
    });

    res.on('close', () => {
      if (!res.writableEnded) {
        cleanup();
      }
    });

    try {
      await pipeline(stdout, res);
    } catch (error) {
      if (!isExpectedDownloadAbortError(error)) {
        this.logger.error('Log download pipeline failed', error);
        if (!res.headersSent) {
          res.status(500).json({ statusCode: 500, message: 'Log download failed' });
        }
      }
    } finally {
      cleanup();
    }
  }

  @UseGuards(AuthGuard)
  @Get('/detect-services')
  async detectServices() {
    return this.systemService.detectDockerServices();
  }
}
