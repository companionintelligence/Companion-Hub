import { Controller, Post, Body, Req, UseGuards, ForbiddenException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { DemoModeGuard } from '@/common/guards/demo-mode.guard';
import { FactoryResetDto } from './dto/factory-reset.dto';
import { FactoryResetService } from './factory-reset.service';

@ApiTags('System')
@Controller('system')
export class FactoryResetController {
  constructor(private readonly factoryResetService: FactoryResetService) {}

  @Post('factory-reset')
  @UseGuards(AuthGuard, DemoModeGuard)
  @ApiOperation({ summary: 'Wipe all Hub state and return to first-operator setup' })
  @ApiResponse({ status: 200, description: 'Factory reset completed' })
  @ApiResponse({ status: 403, description: 'Operator authentication required' })
  async factoryReset(@Req() req: Request, @Body() _body: FactoryResetDto) {
    if (!req.user?.operator) {
      throw new ForbiddenException('Only Hub operators can perform a factory reset');
    }

    return this.factoryResetService.execute();
  }
}
