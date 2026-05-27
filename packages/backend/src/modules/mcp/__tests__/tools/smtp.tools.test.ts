import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { SmtpTools } from '../../tools/smtp.tools';
import { McpToolRegistry } from '../../mcp-tool-registry.service';
import { SmtpService } from '@/modules/smtp/smtp.service';
import { SmtpRegistryService } from '@/modules/smtp/smtp-registry.service';
import { SmtpDnsService } from '@/modules/smtp/smtp-dns.service';
import { LoggerService } from '@/core/logger/logger.service';

describe('SmtpTools', () => {
  let tools: SmtpTools;
  let registry: MockProxy<McpToolRegistry>;
  let smtpService: MockProxy<SmtpService>;
  let smtpRegistryService: MockProxy<SmtpRegistryService>;
  let smtpDnsService: MockProxy<SmtpDnsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmtpTools,
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: McpToolRegistry, useValue: mock<McpToolRegistry>() },
        { provide: SmtpService, useValue: mock<SmtpService>() },
        { provide: SmtpRegistryService, useValue: mock<SmtpRegistryService>() },
        { provide: SmtpDnsService, useValue: mock<SmtpDnsService>() },
      ],
    }).compile();

    tools = module.get(SmtpTools);
    registry = module.get(McpToolRegistry);
    smtpService = module.get(SmtpService);
    smtpRegistryService = module.get(SmtpRegistryService);
    smtpDnsService = module.get(SmtpDnsService);
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  describe('tool registration', () => {
    it('should register hub_get_smtp_status tool', () => {
      tools.onModuleInit();
      expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'hub_get_smtp_status' }));
    });

    it('should register hub_register_smtp_app tool', () => {
      tools.onModuleInit();
      expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'hub_register_smtp_app' }));
    });

    it('should register hub_list_smtp_apps tool', () => {
      tools.onModuleInit();
      expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'hub_list_smtp_apps' }));
    });

    it('should register hub_test_smtp tool', () => {
      tools.onModuleInit();
      expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'hub_test_smtp' }));
    });

    it('should register hub_check_smtp_dns tool', () => {
      tools.onModuleInit();
      expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'hub_check_smtp_dns' }));
    });
  });

  describe('getSmtpStatus', () => {
    it('returns status from SmtpService', async () => {
      smtpService.getStatus.mockReturnValue({ enabled: true, connection: { host: 'hub-smtp', port: 587, security: 'none' } });
      const result = await tools.getSmtpStatus();
      expect(result.enabled).toBe(true);
      expect(result.connection.host).toBe('hub-smtp');
    });
  });

  describe('registerSmtpApp', () => {
    it('returns connection info along with app credentials', async () => {
      smtpRegistryService.getOrCreateAppCredentials.mockResolvedValue({
        appName: 'gitea',
        username: 'gitea@hub.local',
        password: 'pw',
        createdAt: '2024-01-01T00:00:00.000Z',
      });
      smtpService.getConnectionInfo.mockReturnValue({ host: 'hub-smtp', port: 587, security: 'none' });

      const result = await tools.registerSmtpApp({ appName: 'gitea' });

      expect(result.appName).toBe('gitea');
      expect(result.username).toBe('gitea@hub.local');
      expect(result.smtpHost).toBe('hub-smtp');
      expect(result.smtpPort).toBe(587);
    });
  });

  describe('testSmtp', () => {
    it('returns success: false when SMTP not enabled', async () => {
      smtpService.getStatus.mockReturnValue({ enabled: false, connection: { host: 'hub-smtp', port: 587, security: 'none' } });
      const result = await tools.testSmtp();
      expect(result.success).toBe(false);
    });

    it('returns success: true when SMTP is enabled', async () => {
      smtpService.getStatus.mockReturnValue({ enabled: true, connection: { host: 'hub-smtp', port: 587, security: 'none' } });
      const result = await tools.testSmtp();
      expect(result.success).toBe(true);
    });
  });

  describe('listSmtpApps', () => {
    it('returns list of registered apps', async () => {
      smtpRegistryService.listRegisteredApps.mockResolvedValue([
        { appName: 'gitea', username: 'gitea@hub.local', password: 'pw', createdAt: '2024-01-01T00:00:00.000Z' },
        { appName: 'nextcloud', username: 'nextcloud@hub.local', password: 'pw2', createdAt: '2024-01-01T00:00:00.000Z' },
      ]);

      const result = await tools.listSmtpApps();
      expect(result.count).toBe(2);
      expect(result.apps[0].appName).toBe('gitea');
    });
  });

  describe('checkSmtpDns', () => {
    it('delegates to SmtpDnsService', async () => {
      const mockResult = {
        domain: 'example.com',
        mx: { configured: true, value: 'mail.example.com', expected: '1.2.3.4' },
        spf: { configured: true, value: 'v=spf1 ip4:1.2.3.4 ~all', expected: 'v=spf1 ip4:1.2.3.4 ~all' },
        dkim: { configured: false, value: null, expected: 'TXT record at default._domainkey.example.com' },
        dmarc: { configured: false, value: null, expected: 'v=DMARC1; p=quarantine' },
      };
      smtpDnsService.checkDnsRecords.mockResolvedValue(mockResult);

      const result = await tools.checkSmtpDns({ domain: 'example.com', hubIp: '1.2.3.4' });
      expect(result.domain).toBe('example.com');
      expect(result.mx.configured).toBe(true);
      expect(result.dkim.configured).toBe(false);
    });
  });
});
