import { describe, it, expect, vi } from 'vitest';
import { parseComposeJson } from '@ci-hub/common/schemas';
import { buildMainPortRequest, buildComposePortRequests } from '../port-requests';

vi.mock('@ci-hub/common/schemas', async (importOriginal) => ({
  ...((await importOriginal()) as any),
  parseComposeJson: vi.fn().mockReturnValue({ services: [], overrides: [] }),
}));

describe('buildMainPortRequest', () => {
  it('returns null when the app declares no port', () => {
    expect(buildMainPortRequest(undefined, undefined)).toBeNull();
  });

  it('prefers the submitted form port over the manifest default', () => {
    expect(buildMainPortRequest(8080, 9090)).toEqual({ containerPort: 8080, label: 'main', preferredHostPort: 9090 });
  });

  it('falls back to the manifest port when the form supplies none', () => {
    expect(buildMainPortRequest(8080, undefined)).toEqual({ containerPort: 8080, label: 'main', preferredHostPort: 8080 });
  });
});

describe('buildComposePortRequests', () => {
  it('returns nothing for empty compose content', () => {
    expect(buildComposePortRequests(undefined)).toEqual([]);
    expect(buildComposePortRequests('')).toEqual([]);
  });

  it('derives one request per addPorts entry, coercing string ports and defaulting to tcp', () => {
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [
        {
          name: 'app',
          addPorts: [
            { containerPort: 9000, hostPort: 9001 },
            { containerPort: '5353', hostPort: '5353', udp: true },
          ],
        },
        { name: 'db' }, // no addPorts — contributes nothing
      ],
      overrides: [],
    } as any);

    expect(buildComposePortRequests('services: {}')).toEqual([
      { containerPort: 9000, label: 'app-9000', preferredHostPort: 9001, protocol: 'tcp' },
      { containerPort: 5353, label: 'app-5353', preferredHostPort: 5353, protocol: 'udp' },
    ]);
  });

  it('skips an addPorts entry whose port cannot be parsed as a number', () => {
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [{ name: 'app', addPorts: [{ containerPort: 'not-a-number', hostPort: 9001 }] }],
      overrides: [],
    } as any);

    expect(buildComposePortRequests('services: {}')).toEqual([]);
  });

  it('propagates a parse failure to the caller rather than swallowing it', () => {
    vi.mocked(parseComposeJson).mockImplementation(() => {
      throw new Error('invalid compose');
    });

    expect(() => buildComposePortRequests('not valid')).toThrow('invalid compose');
  });
});
