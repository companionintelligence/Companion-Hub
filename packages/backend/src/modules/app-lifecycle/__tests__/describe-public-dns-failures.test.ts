import { describe, expect, it } from 'vitest';
import type { PublicDnsFailure } from '../../cloudflare/cloudflare-client.service';
import { describePublicDnsFailures } from '../exposure-sync.service';

/** What CI-Portal's `subdomainQuotaMessage` sends for a Free organization at its limit. */
const PORTAL_QUOTA_MESSAGE = 'Your plan includes 3 public subdomains (the hub URL does not count). Remove an app or upgrade to publish more.';

describe('describePublicDnsFailures', () => {
  it('names the plan for a quota refusal and does not call it transient', () => {
    const line = describePublicDnsFailures([
      {
        app: 'n8n',
        hostname: 'n8n-laptop-acme.companionintelligence.com',
        reason: 'subdomain_quota_exceeded',
        message: PORTAL_QUOTA_MESSAGE,
      },
    ]);

    expect(line).toContain("n8n: the organization's plan includes no more public app addresses");
    expect(line).toContain('retrying will not help');
    // The Portal's sentence carries the allowance, so the log keeps it.
    expect(line).toContain(`(${PORTAL_QUOTA_MESSAGE})`);
    expect(line).not.toMatch(/transient|Cloudflare rejected|sync retries/);
  });

  it.each([
    ['duplicate_subdomain', 'another app in this sync claimed the same subdomain first'],
    ['release_pending', 'its previous public address has not been released yet'],
    ['write_failed', 'CI-Cloud could not record the app'],
  ] as const)('describes %s as the Portal decided it, not as a Cloudflare error', (reason, expected) => {
    const line = describePublicDnsFailures([{ app: 'n8n', reason, message: 'detail from the Portal' }]);

    expect(line).toContain(`n8n: ${expected}`);
    expect(line).toContain('(detail from the Portal)');
    expect(line).not.toMatch(/transient|Cloudflare rejected/);
  });

  it('keeps the transient wording for a Cloudflare error and for a reason it does not know', () => {
    const line = describePublicDnsFailures([
      { app: 'n8n', reason: 'api_error', message: 'rate limited' },
      { app: 'excalidraw', reason: 'not_yet_invented' as PublicDnsFailure['reason'] },
    ]);

    expect(line).toBe(
      'n8n: Cloudflare rejected the DNS write, usually transient (rate limited); ' +
        'excalidraw: Cloudflare rejected the DNS write, usually transient (no detail)',
    );
  });
});
