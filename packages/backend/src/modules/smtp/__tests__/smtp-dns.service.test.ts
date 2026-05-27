import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { mock } from 'vitest-mock-extended';
import dns from 'node:dns/promises';
import { SmtpDnsService } from '../smtp-dns.service';
import { LoggerService } from '@/core/logger/logger.service';

vi.mock('node:dns/promises', () => ({
  default: {
    resolveMx: vi.fn(),
    resolveTxt: vi.fn(),
    resolve4: vi.fn(),
  },
}));

const mockResolveMx = vi.mocked(dns.resolveMx);
const mockResolveTxt = vi.mocked(dns.resolveTxt);
const mockResolve4 = vi.mocked(dns.resolve4);

describe('SmtpDnsService', () => {
  let service: SmtpDnsService;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [SmtpDnsService, { provide: LoggerService, useValue: mock<LoggerService>() }],
    }).compile();
    service = module.get(SmtpDnsService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('checkDnsRecords', () => {
    it('returns configured: true when all records are set correctly', async () => {
      const HUB_IP = '1.2.3.4';

      mockResolveMx.mockResolvedValue([{ exchange: 'mail.example.com', priority: 10 }]);
      mockResolve4.mockResolvedValue([HUB_IP]);
      mockResolveTxt.mockImplementation((host: string) => {
        if (host === 'example.com') return Promise.resolve([[`v=spf1 ip4:${HUB_IP} ~all`]]);
        if (host === 'default._domainkey.example.com') return Promise.resolve([['v=DKIM1; k=rsa; p=somekey']]);
        if (host === '_dmarc.example.com') return Promise.resolve([['v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com']]);
        return Promise.resolve([]);
      });

      const result = await service.checkDnsRecords('example.com', HUB_IP);

      expect(result.domain).toBe('example.com');
      expect(result.mx.configured).toBe(true);
      expect(result.spf.configured).toBe(true);
      expect(result.dkim.configured).toBe(true);
      expect(result.dmarc.configured).toBe(true);
    });

    it('returns configured: false and error when DNS lookup fails', async () => {
      mockResolveMx.mockRejectedValue(new Error('ENOTFOUND'));
      mockResolveTxt.mockRejectedValue(new Error('ENOTFOUND'));
      mockResolve4.mockRejectedValue(new Error('ENOTFOUND'));

      const result = await service.checkDnsRecords('notconfigured.example.com', '1.2.3.4');

      expect(result.mx.configured).toBe(false);
      expect(result.spf.configured).toBe(false);
      expect(result.dkim.configured).toBe(false);
      expect(result.dmarc.configured).toBe(false);
    });

    it('returns not configured when MX resolves to wrong IP', async () => {
      mockResolveMx.mockResolvedValue([{ exchange: 'mail.example.com', priority: 10 }]);
      mockResolve4.mockResolvedValue(['9.9.9.9']);
      mockResolveTxt.mockResolvedValue([]);

      const result = await service.checkDnsRecords('example.com', '1.2.3.4');

      expect(result.mx.configured).toBe(false);
    });

    it('includes expected record values in result', async () => {
      mockResolveMx.mockRejectedValue(new Error('NXDOMAIN'));
      mockResolveTxt.mockRejectedValue(new Error('NXDOMAIN'));

      const result = await service.checkDnsRecords('example.com', '1.2.3.4');

      expect(result.mx.expected).toBe('1.2.3.4');
      expect(result.spf.expected).toBe('v=spf1 ip4:1.2.3.4 ~all');
      expect(result.dkim.expected).toContain('_domainkey');
      expect(result.dmarc.expected).toContain('DMARC1');
    });
  });
});
