import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { NetworkDiagnosticsService } from './network-diagnostics.service';

@UseGuards(AuthGuard)
@Controller('network')
export class NetworkController {
  constructor(private readonly networkDiagnostics: NetworkDiagnosticsService) {}

  @Get('diagnostics')
  @ApiResponse({ type: Object })
  async getDiagnostics() {
    return this.networkDiagnostics.getDiagnostics();
  }

  @Post('repair-orphans')
  @ApiResponse({ type: Object })
  async repairOrphans(@Body() _body?: Record<string, never>) {
    const repair = await this.networkDiagnostics.repairOrphanNetworks();
    return repair;
  }
}
