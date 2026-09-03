import { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '@/modules/docker/docker.service';
import { ApiResponse } from '@nestjs/swagger';
import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { AuthGuard } from '../auth/auth.guard';
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
  @ApiResponse({ type: HostTelemetryHistoryDto })
  async hostTelemetryHistory() {
    const samples = await this.hostTelemetry.getRecentSamples();
    return HostTelemetryHistoryDto.parse({ samples }, { reportOnly: true });
  }

  @UseGuards(AuthGuard)
  @Get('/events')
  @ApiResponse({ type: HostEventLogDto })
  async hostEventLog() {
    const events = await this.hostTelemetry.getRecentEvents();
    return HostEventLogDto.parse({ events }, { reportOnly: true });
  }

  @UseGuards(AuthGuard)
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
  @Get('/certificate')
  async downloadLocalCertificate(@Res() res: Response) {
    const cert = await this.systemService.getLocalCertificate();

    res.set({
      'Content-Type': 'application/x-pem-file',
      'Content-Disposition': 'attachment; filename=cert.pem',
    });

    return res.send(cert);
  }

  @UseGuards(AuthGuard)
  @Get('/detect-services')
  async detectServices() {
    return this.systemService.detectDockerServices();
  }
}
