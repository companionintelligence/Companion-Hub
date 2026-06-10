import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('../port-availability', () => ({
  isPortAvailable: vi.fn(),
}));

import { spawnSync } from 'node:child_process';
import { parseBindConflictPort, resolveHubPorts } from '../heal-hub-ports';
import { isPortAvailable } from '../port-availability';

const mockedSpawnSync = vi.mocked(spawnSync);
const mockedIsPortAvailable = vi.mocked(isPortAvailable);

describe('heal-hub-ports', () => {
  beforeEach(() => {
    mockedSpawnSync.mockReset();
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      output: ['', ''],
      pid: 0,
      signal: null,
    } as ReturnType<typeof spawnSync>);
    mockedIsPortAvailable.mockReset();
    mockedIsPortAvailable.mockReturnValue(true);
  });

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

  it('does not assign the same host port to multiple services in one resolution pass', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'ci-hub-ports-'));
    const envFile = path.join(tempDir, '.env.dev');
    writeFileSync(
      envFile,
      ['HTTP_PORT=80', 'HTTPS_PORT=443', 'API_PORT=5002', 'POSTGRES_PORT=6543', 'RABBITMQ_PORT=5001', 'TRAEFIK_DASHBOARD_PORT=8080'].join('\n'),
    );

    mockedIsPortAvailable.mockImplementation((port: number) => {
      switch (port) {
        case 5001:
        case 6543:
          return false;
        default:
          return true;
      }
    });

    const result = resolveHubPorts(envFile);

    expect(result.assignments.API_PORT).toBe(5002);
    expect(result.assignments.POSTGRES_PORT).toBe(6544);
    expect(result.assignments.RABBITMQ_PORT).toBe(5003);
    expect(result.assignments.TRAEFIK_DASHBOARD_PORT).toBe(8080);

    rmSync(tempDir, { recursive: true, force: true });
  });
});
