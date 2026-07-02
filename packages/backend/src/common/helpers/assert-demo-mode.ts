import { TranslatableError } from '@/common/error/translatable-error';
import { ConfigurationService } from '@/core/config/configuration.service';

export function assertNotDemoMode(config: ConfigurationService): void {
  if (config.get('demoMode')) {
    throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
  }
}
