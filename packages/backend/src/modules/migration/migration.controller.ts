import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { MigrationService } from './migration.service';
import { GenerateImportScriptDto, GenerateImportScriptResponseDto, GenerateExportScriptResponseDto } from './dto/migration.dto';

@ApiTags('Migration')
@Controller('migration')
@UseGuards(AuthGuard)
export class MigrationController {
  constructor(private readonly migrationService: MigrationService) {}

  @Get('platforms')
  @ApiOperation({ summary: 'List supported source platforms for import migration' })
  @ApiResponse({ status: 200 })
  getSupportedPlatforms() {
    return {
      platforms: [
        { id: 'umbrel', label: 'Umbrel', description: 'App data under ~/umbrel/app-data/' },
        { id: 'casaos', label: 'CasaOS', description: 'App data under /DATA/AppData/' },
        { id: 'synology', label: 'Synology NAS', description: 'App data under /volume1/docker/' },
        { id: 'unraid', label: 'Unraid', description: 'App data under /mnt/user/appdata/' },
        { id: 'docker', label: 'Bare Docker / Docker Compose', description: 'Standard docker-compose.yml' },
        { id: 'runtipi', label: 'Runtipi', description: 'App data under ~/runtipi/app-data/ — nearly 1:1 with CI-Hub' },
      ],
    };
  }

  @Post('import')
  @ApiOperation({ summary: 'Generate an AI migration script to import from another platform' })
  @ApiResponse({ type: GenerateImportScriptResponseDto })
  async generateImportScript(@Body() body: GenerateImportScriptDto) {
    const { script, warnings } = await this.migrationService.generateImportScript(body.platform, body.description);
    return GenerateImportScriptResponseDto.parse({ script, platform: body.platform, warnings }, { reportOnly: true });
  }

  @Post('export')
  @ApiOperation({ summary: 'Generate a portable docker-compose export of the current CI-Hub setup' })
  @ApiResponse({ type: GenerateExportScriptResponseDto })
  async generateExportScript(@Body() body: { description: string }) {
    const { script, composefile, warnings } = await this.migrationService.generateExportScript(body.description ?? '');
    return GenerateExportScriptResponseDto.parse({ script, composefile, warnings }, { reportOnly: true });
  }
}
