import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import { assertNotDemoMode } from '@/common/helpers/assert-demo-mode';

/** Blocks mutating routes when the Hub runs in demo mode. */
@Injectable()
export class DemoModeGuard implements CanActivate {
  constructor(private readonly configuration: ConfigurationService) {}

  canActivate(_context: ExecutionContext): boolean {
    assertNotDemoMode(this.configuration);
    return true;
  }
}
