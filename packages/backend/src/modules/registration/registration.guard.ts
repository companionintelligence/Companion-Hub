import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { RegistrationService } from './registration.service';

@Injectable()
export class RegistrationGuard implements CanActivate {
  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly registrationService: RegistrationService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest() as Request;

    const { ciCloudApiUrl, ciCloudFrontendUrl } = this.config.getConfig();

    // If neither CI Cloud API nor Frontend URL is configured, allow access (backward compatibility)
    // This means CI Cloud integration is not enabled
    if (!ciCloudApiUrl && !ciCloudFrontendUrl) {
      this.logger.debug('CI Cloud integration not configured, allowing access without registration check');
      return true;
    }

    // Check if device is registered (checks database for organization)
    const isRegistered = await this.registrationService.isRegistered();

    if (!isRegistered) {
      this.logger.warn(`Access denied to ${request.url} - device not registered`);
      throw new ForbiddenException('Device must be registered with CI Cloud to access this resource');
    }

    return true;
  }
}
