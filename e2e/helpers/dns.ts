/**
 * DNS Helper for E2E Tests
 *
 * Utilities to verify DNS records during tests
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface DNSRecord {
  name: string;
  type: string;
  value: string;
  ttl?: number;
}

export class DNSHelper {
  private cloudflareToken?: string;
  private cloudflareZoneId?: string;

  constructor() {
    this.cloudflareToken = process.env.CF_API_TOKEN;
    this.cloudflareZoneId = process.env.CF_ZONE_ID;
  }

  /**
   * Check if a DNS record exists using dig
   */
  async recordExists(hostname: string, type = 'A'): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`dig +short ${type} ${hostname}`);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Resolve a hostname
   */
  async resolve(hostname: string, type = 'A'): Promise<string[]> {
    try {
      const { stdout } = await execAsync(`dig +short ${type} ${hostname}`);
      return stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Check if hostname resolves to expected IP
   */
  async resolvesToIP(hostname: string, expectedIP: string): Promise<boolean> {
    const ips = await this.resolve(hostname);
    return ips.includes(expectedIP);
  }

  /**
   * Wait for DNS propagation
   */
  async waitForDNS(
    hostname: string,
    options: {
      timeout?: number;
      interval?: number;
      expectedValue?: string;
    } = {},
  ): Promise<boolean> {
    const timeout = options.timeout || 60000;
    const interval = options.interval || 5000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const exists = await this.recordExists(hostname);
      if (exists) {
        if (options.expectedValue) {
          const values = await this.resolve(hostname);
          if (values.includes(options.expectedValue)) {
            return true;
          }
        } else {
          return true;
        }
      }
      await new Promise((r) => setTimeout(r, interval));
    }

    return false;
  }

  /**
   * Wait for DNS record removal
   */
  async waitForDNSRemoval(hostname: string, options: { timeout?: number; interval?: number } = {}): Promise<boolean> {
    const timeout = options.timeout || 60000;
    const interval = options.interval || 5000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const exists = await this.recordExists(hostname);
      if (!exists) {
        return true;
      }
      await new Promise((r) => setTimeout(r, interval));
    }

    return false;
  }

  /**
   * Get Cloudflare DNS records (requires API token)
   */
  async getCloudflareRecords(name?: string): Promise<DNSRecord[]> {
    if (!this.cloudflareToken || !this.cloudflareZoneId) {
      console.warn('Cloudflare credentials not configured');
      return [];
    }

    try {
      const url = `https://api.cloudflare.com/client/v4/zones/${this.cloudflareZoneId}/dns_records`;
      const params = name ? `?name=${encodeURIComponent(name)}` : '';

      const response = await fetch(`${url}${params}`, {
        headers: {
          Authorization: `Bearer ${this.cloudflareToken}`,
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json();

      if (data.success && data.result) {
        return data.result.map((r: any) => ({
          name: r.name,
          type: r.type,
          value: r.content,
          ttl: r.ttl,
        }));
      }

      return [];
    } catch {
      return [];
    }
  }

  /**
   * Check if Cloudflare record exists
   */
  async cloudflareRecordExists(name: string): Promise<boolean> {
    const records = await this.getCloudflareRecords(name);
    return records.length > 0;
  }
}

// Export singleton
export const dns = new DNSHelper();
