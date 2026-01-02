import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { RegistrationService } from './registration.service';
import { CloudflareTunnelService } from '../cloudflare/cloudflare-tunnel.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

interface RegisterDeviceDto {
  organization_id: string;
  organization_name: string;
}

@ApiTags('Registration')
@Controller('registration')
export class RegistrationController {
  constructor(
    private readonly registrationService: RegistrationService,
    private readonly cloudflareTunnelService: CloudflareTunnelService,
    private readonly config: ConfigurationService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Get device registration status' })
  @ApiResponse({ status: 200, description: 'Returns the registration status' })
  async getStatus() {
    const registered = await this.registrationService.isRegistered();
    return { registered };
  }

  @Get('config')
  @ApiOperation({ summary: 'Get CI Cloud configuration (debug endpoint)' })
  @ApiResponse({ status: 200, description: 'Returns the CI Cloud configuration' })
  async getConfig() {
    const config = this.config.getConfig();
    return {
      ciCloudApiUrl: config.ciCloudApiUrl || null,
      ciHubApiKey: config.ciHubApiKey ? '***configured***' : null,
      ciHubOrganizationId: config.ciHubOrganizationId || null,
      ciCloudAppStoreUrl: config.ciCloudAppStoreUrl || null,
      envFilePath: config.envFilePath,
      // Also check process.env directly
      processEnv: {
        CI_CLOUD_API_URL: process.env.CI_CLOUD_API_URL || null,
        CI_HUB_API_KEY: process.env.CI_HUB_API_KEY ? '***configured***' : null,
        CI_HUB_ORGANIZATION_ID: process.env.CI_HUB_ORGANIZATION_ID || null,
      },
    };
  }

  @Get('validate')
  @ApiOperation({ summary: 'Validate organization name/subdomain availability' })
  @ApiResponse({ status: 200, description: 'Returns validation result' })
  async validateOrganizationName(@Query('name') name: string) {
    if (!name || !name.trim()) {
      return {
        available: false,
        dnsAvailable: false,
        tunnelNameAvailable: false,
        errors: ['Organization name is required'],
      };
    }

    // Sanitize the name
    const sanitizedName = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    
    if (!sanitizedName) {
      return {
        available: false,
        dnsAvailable: false,
        tunnelNameAvailable: false,
        errors: ['Invalid organization name. Please use only letters, numbers, and hyphens.'],
      };
    }

    try {
      const result = await this.cloudflareTunnelService.validateOrganizationSubdomain(sanitizedName);
      return result;
    } catch (error) {
      return {
        available: false,
        dnsAvailable: false,
        tunnelNameAvailable: false,
        errors: ['Failed to validate organization name. Please try again.'],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  @Post('register')
  @ApiOperation({ summary: 'Initiate device registration with organization' })
  @ApiResponse({ status: 200, description: 'Registration initiated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async registerDevice(@Body() body: RegisterDeviceDto) {
    if (!body.organization_id || !body.organization_id.trim()) {
      return {
        success: false,
        message: 'Organization ID is required',
      };
    }

    if (!body.organization_name || !body.organization_name.trim()) {
      return {
        success: false,
        message: 'Organization name is required',
      };
    }

    const result = await this.registrationService.initiateRegistration(
      body.organization_id,
      body.organization_name,
    );
    return result;
  }
}
