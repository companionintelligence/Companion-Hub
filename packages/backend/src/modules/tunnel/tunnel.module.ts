/**
 * Tunnel Module
 *
 * Provides tunnel service abstraction and implementations for multiple providers.
 * Supports Cloudflare, Octelium, Tailscale, and CI Ingress tunnel providers.
 */

import { Module, type OnModuleInit } from '@nestjs/common';
import { TunnelFactory } from './tunnel.factory';
import { OcteliumTunnelService } from './octelium-tunnel.service';
import { CIIngressTunnelService } from './ci-ingress-tunnel.service';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { LoggerModule } from '@/core/logger/logger.module';

@Module({
  imports: [ConfigurationModule, LoggerModule],
  providers: [
    TunnelFactory,
    OcteliumTunnelService,
    CIIngressTunnelService,
  ],
  exports: [TunnelFactory, OcteliumTunnelService, CIIngressTunnelService],
})
export class TunnelModule implements OnModuleInit {
  constructor(
    private readonly tunnelFactory: TunnelFactory,
    private readonly octeliumService: OcteliumTunnelService,
    private readonly ciIngressService: CIIngressTunnelService,
  ) {}

  onModuleInit() {
    // Register available tunnel providers
    this.tunnelFactory.register('octelium', this.octeliumService);
    this.tunnelFactory.register('ci-ingress', this.ciIngressService);
  }
}
