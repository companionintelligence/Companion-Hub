import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { RegistrationService } from './registration.service';
import { isOperational } from './registration-state';

@Injectable()
export class RegistrationGuard implements CanActivate {
  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly registrationService: RegistrationService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest() as Request;

    const { ciCloudUrl } = this.config.getConfig();

    // If CI Cloud URL is not configured, allow access (backward compatibility)
    // This means CI Cloud integration is not enabled
    if (!ciCloudUrl) {
      this.logger.debug('CI Cloud integration not configured, allowing access without registration check');
      return true;
    }

    // Refresh from DB/disk before making access decisions so we do not gate on stale cached state.
    const status = await this.registrationService.getLiveRegistrationStatus();

    if (!isOperational(status.phase)) {
      this.logger.warn(`Access denied to ${request.url} - device not operational (phase: ${status.phase})`);
      throw new ForbiddenException(`Device must be operational to access this resource (current phase: ${status.phase})`);
    }

    return true;
  }
}
