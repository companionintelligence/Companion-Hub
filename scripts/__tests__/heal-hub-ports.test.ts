import { describe, expect, it } from 'vitest';
import { parseBindConflictPort } from '../heal-hub-ports';

describe('heal-hub-ports', () => {
  it('parses port 80 bind conflict from docker daemon output', () => {
    const output =
      'Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:80 -> 127.0.0.1:0: listen tcp 0.0.0.0:80: bind: address already in use';
    expect(parseBindConflictPort(output)).toBe(80);
  });

  it('parses port 443 bind conflict from docker daemon output', () => {
    const output =
      'Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:443 -> 127.0.0.1:0: listen tcp 0.0.0.0:443: bind: address already in use';
    expect(parseBindConflictPort(output)).toBe(443);
  });
});
