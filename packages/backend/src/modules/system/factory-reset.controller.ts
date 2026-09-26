import { Controller, Post, Body, Req, UseGuards, ForbiddenException, BadRequestException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { extractDeviceSlug } from '@ci-hub/common/types';
import type { Request } from 'express';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { DemoModeGuard } from '@/common/guards/demo-mode.guard';
import { RegistrationService } from '@/modules/registration/registration.service';
import { FactoryResetDto } from './dto/factory-reset.dto';
import { FactoryResetService } from './factory-reset.service';

@ApiTags('System')
@Controller('system')
export class FactoryResetController {
  constructor(
    private readonly factoryResetService: FactoryResetService,
    private readonly registrationService: RegistrationService,
  ) {}

  @Post('factory-reset')
  @UseGuards(AuthGuard, DemoModeGuard)
  @ApiOperation({ summary: 'Wipe all Hub state and return to first-operator setup' })
  @ApiResponse({ status: 200, description: 'Factory reset completed' })
  @ApiResponse({ status: 400, description: 'Confirmation does not match this device name' })
  @ApiResponse({ status: 403, description: 'Operator authentication required' })
  async factoryReset(@Req() req: Request, @Body() body: FactoryResetDto) {
    if (!req.user?.operator) {
      throw new ForbiddenException('Only Hub operators can perform a factory reset');
    }

    const registration = await this.registrationService.getDeviceRegistrationInfo();
    const deviceName = extractDeviceSlug(registration?.hubSubdomain, registration?.slug ?? '') ?? '';
    if (!deviceName) {
      throw new BadRequestException('This Hub has no device name to confirm');
    }
    if (body.confirmation !== deviceName) {
      throw new BadRequestException('Confirmation does not match this device name');
    }

    return this.factoryResetService.execute();
  }
}
