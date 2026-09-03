import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { SystemInspectorService } from './system-inspector.service';

// Registered in SystemModule (system.module.ts) as a controller + provider

@ApiTags('System Inspector')
@Controller('system-inspector')
@UseGuards(AuthGuard)
export class SystemInspectorController {
  constructor(private readonly inspector: SystemInspectorService) {}

  @Get()
  @ApiOperation({ summary: 'Full system inspection: ports, containers, health' })
  async getFullInspection() {
    return this.inspector.getFullInspection();
  }

  @Get('containers')
  @ApiOperation({ summary: 'Running Docker containers and their status' })
  async getContainers() {
    return this.inspector.getContainers();
  }

  @Get('ports')
  @ApiOperation({ summary: 'Port allocations with live bind checks' })
  async getPorts() {
    return this.inspector.getPortStatus();
  }

  @Get('health')
  @ApiOperation({ summary: 'System health: CPU, memory, disk, uptime' })
  async getHealth() {
    return this.inspector.getSystemHealth();
  }
}
