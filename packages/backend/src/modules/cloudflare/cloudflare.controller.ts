import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CloudflareTunnelService } from './cloudflare-tunnel.service';
import { ApiResponse } from '@nestjs/swagger';

@UseGuards(AuthGuard)
@Controller('cloudflare')
export class CloudflareController {
  constructor(private readonly cloudflareTunnelService: CloudflareTunnelService) {}

  @Get('check-dns-availability')
  @ApiResponse({ type: Object })
  async checkDnsAvailability(@Query('subdomain') subdomain: string) {
    if (!subdomain) {
      return { available: true };
    }
    
    const result = await this.cloudflareTunnelService.checkDnsAvailability(subdomain);
    return result;
  }
}

