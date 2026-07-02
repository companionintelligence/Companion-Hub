import { describe, it, expect, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppInstallValidator } from '../app-install-validator.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppsRepository } from '@/modules/apps/apps.repository';

describe('AppInstallValidator', () => {
  let validator: AppInstallValidator;
  let configService: ReturnType<typeof mock<ConfigurationService>>;

  beforeEach(() => {
    configService = mock<ConfigurationService>();
    validator = new AppInstallValidator(mock<AppsRepository>(), configService);
  });

  it('clears exposed/domain in production before validating domain rules', () => {
    configService.getConfig.mockReturnValue({ isProduction: true } as any);
    const parsedForm = { exposed: true, domain: 'not-a-valid-domain' } as any;

    expect(() => validator.assertDomainRules(parsedForm)).not.toThrow();
    expect(parsedForm.exposed).toBe(false);
    expect(parsedForm.domain).toBeUndefined();
  });
});
