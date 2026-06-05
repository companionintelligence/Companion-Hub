import { describe, expect, it } from 'vitest';
import { formatPublicWebStatusTable } from '../public-web-cli';

describe('formatPublicWebStatusTable', () => {
  it('renders table rows for diagnostics', () => {
    const lines = formatPublicWebStatusTable({
      mismatchCount: 1,
      apps: [
        {
          appUrn: 'nextcloud:store',
          appName: 'nextcloud',
          status: 'running',
          dbPublicDomain: 'example.com',
          computedHostname: 'nextcloud-dev1-myorg.example.com',
          computedPublicUrl: 'https://nextcloud-dev1-myorg.example.com',
          envHostname: 'nextcloud-wrong.example.com',
          envMismatch: true,
          action: 'repair',
        },
      ],
    });

    expect(lines.some((line) => line.includes('nextcloud'))).toBe(true);
    expect(lines.some((line) => line.includes('mismatch'))).toBe(true);
    expect(lines.some((line) => line.includes('need repair'))).toBe(true);
  });

  it('returns empty message when no apps', () => {
    const lines = formatPublicWebStatusTable({ apps: [], mismatchCount: 0 });
    expect(lines).toEqual(['No cloudflare-exposed apps found.']);
  });
});
