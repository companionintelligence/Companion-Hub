import { ConfigurationService } from '@/core/config/configuration.service';
import { RegistrationService } from '@/modules/registration/registration.service';
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PortalClientService } from './portal-client.service';

@ApiTags('Portal')
@Controller('portal')
export class PortalController {
  constructor(
    private readonly portalClient: PortalClientService,
    private readonly configuration: ConfigurationService,
    private readonly registrationService: RegistrationService,
  ) {}

  @Get('config')
  @ApiOperation({ summary: 'Portal URL and device registration metadata for the frontend' })
  @ApiResponse({ status: 200, description: 'Portal configuration' })
  async getPortalConfig() {
    const portalUrl = this.portalClient.getPublicPortalUrl();
    const deviceId = portalUrl ? await this.registrationService.getDeviceId() : null;
    const registrationUrl =
      portalUrl && deviceId ? `${portalUrl.replace(/\/+$/, '')}/device/register?device_id=${encodeURIComponent(deviceId)}` : null;

    return {
      portalUrl: portalUrl || null,
      deviceId,
      registrationUrl,
      demoMode: this.configuration.get('demoMode'),
    };
  }
}
