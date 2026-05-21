/**
 * Tunnel Module
 *
 * Provides tunnel service abstraction and implementations for multiple providers.
 * Supports Cloudflare, Octelium, and Tailscale tunnel providers.
 */

import { Module, type OnModuleInit } from '@nestjs/common';
import { TunnelFactory } from './tunnel.factory';
import { OcteliumTunnelService } from './octelium-tunnel.service';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { LoggerModule } from '@/core/logger/logger.module';

@Module({
  imports: [ConfigurationModule, LoggerModule],
  providers: [
    TunnelFactory,
    OcteliumTunnelService,
  ],
  exports: [TunnelFactory, OcteliumTunnelService],
})
export class TunnelModule implements OnModuleInit {
  constructor(
    private readonly tunnelFactory: TunnelFactory,
    private readonly octeliumService: OcteliumTunnelService,
  ) {}

  onModuleInit() {
    // Register available tunnel providers
    this.tunnelFactory.register('octelium', this.octeliumService);
  }
}
