/**
 * `cihub version` reports two artifacts, because they update independently.
 *
 * Rolling the Hub image never updates the `cihub` binary — they ship through separate channels —
 * so one number cannot describe both. And the Hub half has to be honest about provenance: the
 * failure being fixed was a Hub confidently reporting `CI_HUB_VERSION` from its install's env file,
 * a value no build writes and which was wrong on 10 of 16 fleet Hubs (measured 2026-09-17).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchHubBuildInfo, formatHubBuildLines, type HubBuildInfoResponse, runVersionCommand } from '../lib/cli-update';

const RELEASE_BUILD: HubBuildInfoResponse = {
  version: '0.2.73',
  channel: 'latest',
  gitSha: 'dac546bcffe0f105539615d94c8139e4522c050a',
  gitShaShort: 'dac546bcf',
  builtAt: '2026-09-17T07:44:35.701Z',
  imageRef: 'ghcr.io/companionintelligence/ci-hub:0.2.73',
  imageDigest: `sha256:${'d8f0b6a0c955'.padEnd(64, '0')}`,
  source: 'image',
  declaredVersion: '0.2.73',
  summary: '0.2.73 (dac546bcf)',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stub fetch with one JSON response, and record what was requested. */
function stubFetch(response: { ok: boolean; body?: unknown }): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    calls.push(String(url));
    return Promise.resolve({ ok: response.ok, json: () => Promise.resolve(response.body) } as Response);
  });
  return { calls };
}

describe('formatHubBuildLines', () => {
  it('names the build, its channel, image, digest and build time', () => {
    const lines = formatHubBuildLines(RELEASE_BUILD, 'http://127.0.0.1:5002');

    expect(lines[0]).toBe('hub    0.2.73 (dac546bcf)');
    expect(lines.join('\n')).toContain('channel latest');
    expect(lines.join('\n')).toContain('image   ghcr.io/companionintelligence/ci-hub:0.2.73');
    // The digest is the only thing that separates two images sharing a tag — the measured case was
    // 17 appliances on one untagged index while :latest and :dev were two other indexes entirely.
    expect(lines.join('\n')).toContain('digest  sha256:');
    expect(lines.join('\n')).toContain('built   2026-09-17T07:44:35.701Z');
  });

  it('flags an env file whose CI_HUB_VERSION disagrees with the running build', () => {
    // beta-red ran a :dev build newer than 0.2.71 while its env file read v0.2.22, and the daily
    // check concluded it was out of date. Printing both is what makes that visible.
    const lines = formatHubBuildLines({ ...RELEASE_BUILD, declaredVersion: 'v0.2.22' }, 'http://127.0.0.1:5002').join('\n');

    expect(lines).toContain('env file says CI_HUB_VERSION=v0.2.22');
  });

  it('does not flag a v-prefixed env value that names the same release', () => {
    // GHCR tags are unprefixed and hub_env.rs strips the `v`, so `v0.2.73` and `0.2.73` agree.
    const lines = formatHubBuildLines({ ...RELEASE_BUILD, declaredVersion: 'v0.2.73' }, 'http://127.0.0.1:5002').join('\n');

    expect(lines).not.toContain('does not match this build');
  });

  it('reports an unstamped image as unidentified rather than borrowing the env file number', () => {
    const lines = formatHubBuildLines({ source: 'unstamped', declaredVersion: '4.5.0' }, 'http://127.0.0.1:5002').join('\n');

    expect(lines).toContain('no build stamp');
    expect(lines).toContain('env file claims 4.5.0');
    // `4.5.0` must never be printed as if it were the running build; that is the original bug.
    expect(lines).not.toMatch(/^hub {4}4\.5\.0/);
  });

  it('names the address it could not reach', () => {
    expect(formatHubBuildLines(null, 'http://127.0.0.1:5099')).toEqual(['hub    not reachable at http://127.0.0.1:5099']);
  });
});

describe('fetchHubBuildInfo', () => {
  it('asks the Hub-native build path, not either Ollama-compatibility version route', () => {
    const { calls } = stubFetch({ ok: true, body: RELEASE_BUILD });

    return fetchHubBuildInfo('http://127.0.0.1:5002').then((info) => {
      expect(calls).toEqual(['http://127.0.0.1:5002/api/hub/build']);
      expect(info?.version).toBe('0.2.73');
    });
  });

  it('returns null for a Hub too old to have the endpoint', async () => {
    // A 404 here is an ordinary state, not an error to surface: the CLI updates independently of
    // the Hub image, so a new binary routinely talks to an older Hub.
    stubFetch({ ok: false });

    expect(await fetchHubBuildInfo('http://127.0.0.1:5002')).toBeNull();
  });

  it('returns null when the Hub is unreachable instead of throwing', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));

    expect(await fetchHubBuildInfo('http://127.0.0.1:5002')).toBeNull();
  });

  it('returns null when the body is not an object', async () => {
    stubFetch({ ok: true, body: 'not json' });

    expect(await fetchHubBuildInfo('http://127.0.0.1:5002')).toBeNull();
  });
});

describe('runVersionCommand', () => {
  it('prints the CLI version and the Hub build as separate lines', async () => {
    stubFetch({ ok: true, body: RELEASE_BUILD });

    const output = await runVersionCommand('http://127.0.0.1:5002');
    const [first, ...rest] = output.split('\n');

    expect(first).toContain('cihub');
    expect(rest.join('\n')).toContain('0.2.73 (dac546bcf)');
  });

  it('still reports the CLI version when no Hub answers', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));

    const output = await runVersionCommand('http://127.0.0.1:5002');

    expect(output.split('\n')[0]).toContain('cihub');
    expect(output).toContain('not reachable');
  });
});
