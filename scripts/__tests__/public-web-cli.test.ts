import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatPublicWebStatusTable, resolveHubApiBase } from '../public-web-cli';

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

describe('resolveHubApiBase', () => {
  const tmpRoot = join(process.cwd(), '.tmp-public-web-cli-test');

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.API_PORT;
  });

  it('prefers API_PORT from the env file over process.env', () => {
    mkdirSync(tmpRoot, { recursive: true });
    const envFile = join(tmpRoot, '.env.dev');
    writeFileSync(envFile, 'API_PORT=5002\n');
    process.env.API_PORT = '9999';

    expect(resolveHubApiBase(envFile)).toBe('http://127.0.0.1:5002');
  });
});
