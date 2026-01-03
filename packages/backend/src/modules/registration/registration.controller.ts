import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RegistrationService } from './registration.service';
import { CloudflareTunnelService } from '../cloudflare/cloudflare-tunnel.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

interface RegisterDeviceDto {
  organization_id: string;
  organization_name: string;
  device_id?: string; // Optional: custom device ID (auto-generated if not provided)
  description?: string; // Optional: custom description (auto-generated if not provided)
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

  @Get('device-id')
  @ApiOperation({ summary: 'Get device ID for registration redirect' })
  @ApiResponse({ status: 200, description: 'Returns the device ID and registration URL' })
  async getDeviceId(@Req() req: Request) {
    const deviceId = await this.registrationService.getDeviceId();
    const { ciCloudFrontendUrl } = this.config.getConfig();

    // Build callback URL (where CI Cloud should redirect back to)
    // Use the request origin to construct the callback URL
    const protocol = req.protocol || 'http';
    const host = req.get('host') || 'localhost:3000';
    const callbackUrl = `${protocol}://${host}/device-registration`;

    // Build registration URL with callback parameter
    // Handle empty string as well as null/undefined
    const registrationUrl = ciCloudFrontendUrl?.trim()
      ? `${ciCloudFrontendUrl.trim()}/device/register?device_id=${encodeURIComponent(deviceId)}&callback_url=${encodeURIComponent(callbackUrl)}`
      : null;

    return {
      device_id: deviceId,
      registration_url: registrationUrl,
      callback_url: callbackUrl,
      ci_cloud_frontend_url: ciCloudFrontendUrl || null, // For debugging
    };
  }

  @Get('callback')
  @ApiOperation({ summary: 'Handle registration callback from CI Cloud' })
  @ApiResponse({ status: 200, description: 'Registration completed successfully' })
  @ApiResponse({ status: 400, description: 'Invalid callback data' })
  async handleCallback(
    @Query('device_id') deviceId: string,
    @Query('organization_id') organizationId: string,
    @Query('organization_name') organizationName: string,
    @Query('subdomain') subdomain: string,
    @Query('tunnel_id') tunnelId?: string,
  ) {
    if (!deviceId || !organizationId || !organizationName || !subdomain) {
      return {
        success: false,
        message: 'Missing required parameters: device_id, organization_id, organization_name, subdomain',
      };
    }

    const result = await this.registrationService.completeRegistrationFromCallback({
      deviceId,
      organizationId,
      organizationName,
      subdomain,
      tunnelId,
    });

    return result;
  }

  @Get('config')
  @ApiOperation({ summary: 'Get CI Cloud configuration (debug endpoint)' })
  @ApiResponse({ status: 200, description: 'Returns the CI Cloud configuration' })
  async getConfig() {
    const config = this.config.getConfig();
    const fs = await import('node:fs');
    const _path = await import('node:path');

    // Try to read the .env file directly to debug
    let envFileContent = null;
    let envFileLines: string[] = [];
    try {
      const envPath = config.envFilePath;
      if (fs.existsSync(envPath)) {
        envFileContent = fs.readFileSync(envPath, 'utf-8');
        envFileLines = envFileContent.split('\n').filter((line) => line.includes('CI_CLOUD') && !line.trim().startsWith('#'));
      }
    } catch (_e) {
      // Ignore errors reading file
    }

    return {
      ciCloudApiUrl: config.ciCloudApiUrl || null,
      ciCloudFrontendUrl: config.ciCloudFrontendUrl || null,
      ciHubApiKey: config.ciHubApiKey ? '***configured***' : null,
      ciHubOrganizationId: config.ciHubOrganizationId || null,
      ciCloudAppStoreUrl: config.ciCloudAppStoreUrl || null,
      envFilePath: config.envFilePath,
      // Debug: show what's in the .env file
      envFileLines: envFileLines.length > 0 ? envFileLines : null,
      // Also check process.env directly
      processEnv: {
        CI_CLOUD_API_URL: process.env.CI_CLOUD_API_URL || null,
        CI_CLOUD_FRONTEND_URL: process.env.CI_CLOUD_FRONTEND_URL || null,
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
    const sanitizedName = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

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
      body.device_id,
      body.description,
    );
    return result;
  }
}
