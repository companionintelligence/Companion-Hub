import { describe, expect, it, vi } from 'vitest';
import { engineMajorVersion, withoutUnsupportedStartInterval } from '../healthcheck-start-interval';

const services = () => [
  { name: 'uptime-kuma', healthCheck: { test: 'curl -f http://localhost:3001', interval: '30s', startInterval: '5s', startPeriod: '60s' } },
  { name: 'db', healthCheck: { test: 'pg_isready', interval: '10s' } },
  { name: 'worker' },
];

describe('engineMajorVersion', () => {
  it.each([
    ['24.0.9', 24],
    ['25.0.3', 25],
    ['28.2.2-0ubuntu1', 28],
    ['v29.1.0', 29],
  ])('reads %s as %i', (raw, major) => {
    expect(engineMajorVersion(raw)).toBe(major);
  });

  it.each([undefined, null, '', 'dev'])('reads %s as unknown', (raw) => {
    expect(engineMajorVersion(raw)).toBeNull();
  });
});

describe('withoutUnsupportedStartInterval', () => {
  // Compose 2.40 with Engine 24.0.9: "can't set healthcheck.start_interval as feature require Docker Engine v25 or later".
  it('leaves start_interval out on Engine 24 and says which service lost it', () => {
    const dropped = vi.fn();

    const result = withoutUnsupportedStartInterval(services(), '24.0.9', dropped);

    expect(result[0]?.healthCheck).toEqual({ test: 'curl -f http://localhost:3001', interval: '30s', startPeriod: '60s' });
    expect(result[1]).toEqual(services()[1]);
    expect(result[2]).toEqual(services()[2]);
    expect(dropped).toHaveBeenCalledOnce();
    expect(dropped).toHaveBeenCalledWith(expect.objectContaining({ name: 'uptime-kuma' }));
  });

  it.each(['25.0.0', '28.2.2-0ubuntu1', '29.6.1'])('keeps start_interval on Engine %s', (version) => {
    const dropped = vi.fn();

    expect(withoutUnsupportedStartInterval(services(), version, dropped)).toEqual(services());
    expect(dropped).not.toHaveBeenCalled();
  });

  it('keeps start_interval when the engine version is unknown', () => {
    expect(withoutUnsupportedStartInterval(services(), undefined, vi.fn())).toEqual(services());
  });
});
