import { castAppUrn } from '@/common/helpers/app-helpers';
import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { buildMcpInstallSchema } from '@ci-hub/common/validation';
import { AuthGuard } from '../auth/auth.guard';
import { AppsService } from '../apps/apps.service';
import { McpProbeService } from './mcp-probe.service';
import { McpInstallSchemaDto, McpProbeResultDto } from './dto/mcp-app.dto';

@Controller('apps')
@UseGuards(AuthGuard)
export class McpAppsController {
  constructor(
    private readonly appsService: AppsService,
    private readonly mcpProbeService: McpProbeService,
  ) {}

  @Get(':urn/mcp/status')
  @ApiResponse({ type: McpProbeResultDto })
  async getMcpStatus(@Param('urn') urn: string) {
    const appUrn = castAppUrn(urn);
    const cached = this.mcpProbeService.getCached(appUrn);
    if (cached) {
      return McpProbeResultDto.parse(cached, { reportOnly: true });
    }
    const result = await this.mcpProbeService.probe(appUrn);
    return McpProbeResultDto.parse(result, { reportOnly: true });
  }

  @Post(':urn/mcp/probe')
  @ApiResponse({ type: McpProbeResultDto })
  async probeMcp(@Param('urn') urn: string) {
    const result = await this.mcpProbeService.probe(castAppUrn(urn));
    return McpProbeResultDto.parse(result, { reportOnly: true });
  }

  @Get(':urn/mcp/install-schema')
  @ApiResponse({ type: McpInstallSchemaDto })
  async getMcpInstallSchema(@Param('urn') urn: string) {
    const { info } = await this.appsService.getApp(castAppUrn(urn));
    const schema = buildMcpInstallSchema(info);
    return McpInstallSchemaDto.parse(schema ?? { bridgeable: false, transport: 'stdio', tags: [], fields: [], toolCount: 0 }, { reportOnly: true });
  }
}
