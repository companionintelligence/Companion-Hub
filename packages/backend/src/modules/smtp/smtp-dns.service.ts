import dns from 'node:dns/promises';
import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';

export interface DnsRecordStatus {
  configured: boolean;
  value: string | null;
  expected: string;
  error?: string;
}

export interface SmtpDnsCheckResult {
  domain: string;
  mx: DnsRecordStatus;
  spf: DnsRecordStatus;
  dkim: DnsRecordStatus;
  dmarc: DnsRecordStatus;
}

/**
 * SmtpDnsService — verifies that DNS records required for direct email delivery
 * (MX, SPF, DKIM, DMARC) are properly configured for the Hub's domain.
 */
@Injectable()
export class SmtpDnsService {
  constructor(readonly logger: LoggerService) {}

  /**
   * Check DNS records for `domain` against the Hub's public IP.
   *
   * @param domain    - The Hub's public domain (e.g. "yourdomain.com")
   * @param hubIp     - The Hub's public IP address
   * @param dkimSelector - DKIM selector (default: "default")
   */
  async checkDnsRecords(domain: string, hubIp: string, dkimSelector = 'default'): Promise<SmtpDnsCheckResult> {
    const [mxStatus, spfStatus, dkimStatus, dmarcStatus] = await Promise.all([
      this.checkMx(domain, hubIp),
      this.checkSpf(domain, hubIp),
      this.checkDkim(domain, dkimSelector),
      this.checkDmarc(domain),
    ]);

    return { domain, mx: mxStatus, spf: spfStatus, dkim: dkimStatus, dmarc: dmarcStatus };
  }

  private async checkMx(domain: string, hubIp: string): Promise<DnsRecordStatus> {
    const expected = hubIp;
    try {
      const records = await dns.resolveMx(domain);
      const topMx = records.sort((a, b) => a.priority - b.priority)[0];
      if (!topMx) {
        return { configured: false, value: null, expected };
      }
      const resolvedIps = await dns.resolve4(topMx.exchange).catch(() => [] as string[]);
      const configured = resolvedIps.includes(hubIp);
      return { configured, value: topMx.exchange, expected };
    } catch (err) {
      return { configured: false, value: null, expected, error: String(err) };
    }
  }

  private async checkSpf(domain: string, hubIp: string): Promise<DnsRecordStatus> {
    const expected = `v=spf1 ip4:${hubIp} ~all`;
    try {
      const records = await dns.resolveTxt(domain);
      const spfRecord = records.flat().find((r) => r.startsWith('v=spf1'));
      if (!spfRecord) {
        return { configured: false, value: null, expected };
      }
      const configured = spfRecord.includes(`ip4:${hubIp}`) || spfRecord.includes('include:');
      return { configured, value: spfRecord, expected };
    } catch (err) {
      return { configured: false, value: null, expected, error: String(err) };
    }
  }

  private async checkDkim(domain: string, selector: string): Promise<DnsRecordStatus> {
    const dkimHost = `${selector}._domainkey.${domain}`;
    const expected = `TXT record at ${dkimHost}`;
    try {
      const records = await dns.resolveTxt(dkimHost);
      const dkimRecord = records.flat().find((r) => r.startsWith('v=DKIM1'));
      if (!dkimRecord) {
        return { configured: false, value: null, expected };
      }
      return { configured: true, value: `${dkimRecord.slice(0, 64)}...`, expected };
    } catch (err) {
      return { configured: false, value: null, expected, error: String(err) };
    }
  }

  private async checkDmarc(domain: string): Promise<DnsRecordStatus> {
    const dmarcHost = `_dmarc.${domain}`;
    const expected = 'v=DMARC1; p=quarantine';
    try {
      const records = await dns.resolveTxt(dmarcHost);
      const dmarcRecord = records.flat().find((r) => r.startsWith('v=DMARC1'));
      if (!dmarcRecord) {
        return { configured: false, value: null, expected };
      }
      return { configured: true, value: dmarcRecord, expected };
    } catch (err) {
      return { configured: false, value: null, expected, error: String(err) };
    }
  }
}
