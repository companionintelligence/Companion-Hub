import { describe, it, expect, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { SmtpInjectorService, detectSmtpCategory, SMTP_PATTERNS } from '../smtp-injector.service';
import { SmtpService } from '../smtp.service';
import { SmtpRegistryService } from '../smtp-registry.service';
import { LoggerService } from '@/core/logger/logger.service';

describe('detectSmtpCategory', () => {
  it.each([
    ['SMTP_HOST', 'host'],
    ['SMTP_ADDR', 'host'],
    ['SMTP_SERVER', 'host'],
    ['MAILER_HOST', 'host'],
    ['MAILER_SMTP_HOST', 'host'],
    ['SMTP_PORT', 'port'],
    ['MAILER_PORT', 'port'],
    ['SMTP_USER', 'user'],
    ['SMTP_USERNAME', 'user'],
    ['MAILER_SMTP_USER', 'user'],
    ['SMTP_PASS', 'pass'],
    ['SMTP_PASSWORD', 'pass'],
    ['MAILER_SMTP_PASSWORD', 'pass'],
    ['SMTP_FROM', 'from'],
    ['MAIL_FROM', 'from'],
    ['FROM_EMAIL', 'from'],
    ['FROM_ADDRESS', 'from'],
    ['SMTP_FROM_ADDRESS', 'from'],
    ['MAILER_SMTP_ENABLE', 'enable'],
    ['SMTP_ENABLED', 'enable'],
    ['SMTP_SECURITY', 'security'],
    ['SMTP_SECURE', 'security'],
  ])('detects %s as category %s', (envVar, expectedCategory) => {
    expect(detectSmtpCategory(envVar)).toBe(expectedCategory);
  });

  it('returns null for unrelated env vars', () => {
    expect(detectSmtpCategory('DATABASE_URL')).toBeNull();
    expect(detectSmtpCategory('APP_PORT')).toBeNull();
    expect(detectSmtpCategory('SECRET_KEY')).toBeNull();
  });

  it('exports SMTP_PATTERNS with all categories', () => {
    expect(Object.keys(SMTP_PATTERNS)).toEqual(expect.arrayContaining(['host', 'port', 'user', 'pass', 'from', 'enable', 'security']));
  });
});

describe('SmtpInjectorService', () => {
  let injector: SmtpInjectorService;
  let smtpService: MockProxy<SmtpService>;
  let smtpRegistry: MockProxy<SmtpRegistryService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmtpInjectorService,
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: SmtpService, useValue: mock<SmtpService>() },
        { provide: SmtpRegistryService, useValue: mock<SmtpRegistryService>() },
      ],
    }).compile();

    injector = module.get(SmtpInjectorService);
    smtpService = module.get(SmtpService);
    smtpRegistry = module.get(SmtpRegistryService);
  });

  it('should be defined', () => {
    expect(injector).toBeDefined();
  });

  describe('injectSmtpEnv', () => {
    it('does nothing when Hub SMTP is disabled', async () => {
      smtpService.isEnabled.mockReturnValue(false);
      const envMap = new Map([['SMTP_HOST', '']]);
      await injector.injectSmtpEnv('testapp', envMap, 'hub.local');
      expect(envMap.get('SMTP_HOST')).toBe('');
      expect(smtpRegistry.getOrCreateAppCredentials).not.toHaveBeenCalled();
    });

    it('injects SMTP host, port, user, pass, from, enable, security', async () => {
      smtpService.isEnabled.mockReturnValue(true);
      smtpService.getConnectionInfo.mockReturnValue({ host: 'hub-smtp', port: 587, security: 'none' });
      smtpRegistry.getOrCreateAppCredentials.mockResolvedValue({
        appName: 'nextcloud',
        username: 'nextcloud@hub.local',
        password: 'supersecret',
        createdAt: new Date().toISOString(),
      });

      const envMap = new Map([
        ['SMTP_HOST', ''],
        ['SMTP_PORT', ''],
        ['SMTP_USERNAME', ''],
        ['SMTP_PASSWORD', ''],
        ['SMTP_FROM_ADDRESS', ''],
        ['MAILER_SMTP_ENABLE', ''],
        ['SMTP_SECURITY', ''],
      ]);

      await injector.injectSmtpEnv('nextcloud', envMap, 'example.com');

      expect(envMap.get('SMTP_HOST')).toBe('hub-smtp');
      expect(envMap.get('SMTP_PORT')).toBe('587');
      expect(envMap.get('SMTP_USERNAME')).toBe('nextcloud@hub.local');
      expect(envMap.get('SMTP_PASSWORD')).toBe('supersecret');
      expect(envMap.get('SMTP_FROM_ADDRESS')).toBe('nextcloud@example.com');
      expect(envMap.get('MAILER_SMTP_ENABLE')).toBe('true');
      expect(envMap.get('SMTP_SECURITY')).toBe('none');
    });

    it('does not overwrite env vars that already have values', async () => {
      smtpService.isEnabled.mockReturnValue(true);
      smtpService.getConnectionInfo.mockReturnValue({ host: 'hub-smtp', port: 587, security: 'none' });
      smtpRegistry.getOrCreateAppCredentials.mockResolvedValue({
        appName: 'gitea',
        username: 'gitea@hub.local',
        password: 'pw',
        createdAt: new Date().toISOString(),
      });

      const envMap = new Map([
        ['SMTP_HOST', 'smtp.sendgrid.net'],
        ['SMTP_PORT', ''],
      ]);

      await injector.injectSmtpEnv('gitea', envMap, 'example.com');

      expect(envMap.get('SMTP_HOST')).toBe('smtp.sendgrid.net');
      expect(envMap.get('SMTP_PORT')).toBe('587');
    });

    it('skips env vars that are not SMTP-related', async () => {
      smtpService.isEnabled.mockReturnValue(true);
      smtpService.getConnectionInfo.mockReturnValue({ host: 'hub-smtp', port: 587, security: 'none' });
      smtpRegistry.getOrCreateAppCredentials.mockResolvedValue({
        appName: 'app',
        username: 'app@hub.local',
        password: 'pw',
        createdAt: new Date().toISOString(),
      });

      const envMap = new Map([
        ['DATABASE_URL', ''],
        ['SMTP_HOST', ''],
      ]);

      await injector.injectSmtpEnv('app', envMap, 'hub.local');

      expect(envMap.get('DATABASE_URL')).toBe('');
      expect(envMap.get('SMTP_HOST')).toBe('hub-smtp');
    });

    it('uses "hub.local" domain in from address when no public domain', async () => {
      smtpService.isEnabled.mockReturnValue(true);
      smtpService.getConnectionInfo.mockReturnValue({ host: 'hub-smtp', port: 587, security: 'none' });
      smtpRegistry.getOrCreateAppCredentials.mockResolvedValue({
        appName: 'documenso',
        username: 'documenso@hub.local',
        password: 'pw',
        createdAt: new Date().toISOString(),
      });

      const envMap = new Map([['SMTP_FROM_ADDRESS', '']]);

      await injector.injectSmtpEnv('documenso', envMap, 'hub.local');

      expect(envMap.get('SMTP_FROM_ADDRESS')).toBe('documenso@hub.local');
    });
  });
});
