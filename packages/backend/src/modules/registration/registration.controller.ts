import { Controller, Get } from '@nestjs/common';
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
    return { registered };
  }
}
