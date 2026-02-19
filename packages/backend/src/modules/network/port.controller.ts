import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PortManagerService } from './port-manager.service';
import { AuthGuard } from '@/modules/auth/auth.guard';
import type { AppUrn } from '@runtipi/common/types';

@ApiTags('Ports')
@Controller('ports')
@UseGuards(AuthGuard)
export class PortController {
  constructor(private readonly portManager: PortManagerService) {}

  @Get()
  @ApiOperation({ summary: 'Get all port allocations' })
  @ApiResponse({ status: 200, description: 'Returns all port allocations across all apps' })
  async getAllAllocations() {
    const allocations = await this.portManager.getAllAllocations();
    return { allocations };
  }

  @Get(':appUrn')
  @ApiOperation({ summary: 'Get port allocations for a specific app' })
  @ApiResponse({ status: 200, description: 'Returns port allocations for the specified app' })
  async getAppPorts(@Param('appUrn') appUrn: string) {
    const allocations = await this.portManager.getAppPorts(appUrn as AppUrn);
    return { allocations };
  }

  @Get(':appUrn/check')
  @ApiOperation({ summary: 'Check port availability for an app' })
  @ApiResponse({ status: 200, description: 'Returns current port status and availability' })
  async checkAppPorts(@Param('appUrn') appUrn: string) {
    const allocations = await this.portManager.getAppPorts(appUrn as AppUrn);
    const checks = await Promise.all(
      allocations.map(async (alloc) => ({
        ...alloc,
        available: await this.portManager.isPortAvailable(alloc.hostPort, alloc.protocol as 'tcp' | 'udp'),
      })),
    );
    return { allocations: checks };
  }
}
