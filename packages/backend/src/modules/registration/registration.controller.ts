import { Controller, Get, Post, Body } from '@nestjs/common';
import { RegistrationService } from './registration.service';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('Registration')
@Controller('registration')
export class RegistrationController {
  constructor(private readonly registrationService: RegistrationService) {}

  @Get('status')
  @ApiOperation({ summary: 'Get device registration status' })
  @ApiResponse({ status: 200, description: 'Returns the registration status' })
  async getStatus() {
    const registered = await this.registrationService.isRegistered();
    const registrationUrl = this.registrationService.getRegistrationUrl();
    return { registered, registrationUrl };
  }

  @Post('complete')
  @ApiOperation({ summary: 'Complete device registration' })
  async completeRegistration(@Body() body: { subdomain: string; registrationId: string }) {
    await this.registrationService.completeRegistration(body.subdomain, body.registrationId);
    return { success: true };
  }
}
