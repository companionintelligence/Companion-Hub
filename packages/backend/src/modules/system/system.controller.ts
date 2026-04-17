import { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '@/modules/docker/docker.service';
import { ApiResponse } from '@nestjs/swagger';
import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { AuthGuard } from '../auth/auth.guard';
import { LoadDto } from './dto/system.dto';
import { SystemService } from './system.service';

@Controller('system')
export class SystemController {
  constructor(
    private readonly systemService: SystemService,
    private readonly dockerService: DockerService,
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
  @Get('/logs/download')
  @ApiResponse({ status: 200, description: 'Hub logs download' })
  async downloadHubLogs(@Res() res: Response) {
    const { stdout, stderr, kill } = await this.dockerService.getLogsDownloadStream();
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
    } finally {
      cleanup();
    }
  }

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
