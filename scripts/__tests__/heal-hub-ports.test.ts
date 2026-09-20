import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { configuredPort, healHubPortsBeforeStartup, parseBindConflictPort, resolveHubPorts } from '../heal-hub-ports';
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

  it('falls back to the default when a configured port is not a port, and repairs the file', () => {
    // A key appended to an env file with no trailing newline lands on the previous line:
    // `TRAEFIK_DASHBOARD_PORT=8080LEMONADE_URL=…`. Number() of that is NaN, a bind probe on
    // NaN is a bind on port 0 (always free), and `NaN` was written back — compose then refused
    // the file with `invalid hostPort: NaN`.
    const tempDir = mkdtempSync(path.join(tmpdir(), 'ci-hub-ports-'));
    const envFile = path.join(tempDir, '.env.dev');
    writeFileSync(
      envFile,
      [
        'HTTP_PORT=80',
        'HTTPS_PORT=443',
        'API_PORT=5002',
        'POSTGRES_PORT=6543',
        'RABBITMQ_PORT=5001',
        'TRAEFIK_DASHBOARD_PORT=8080LEMONADE_URL=http://100.67.181.7:13305',
        '',
      ].join('\n'),
    );

    const result = resolveHubPorts(envFile);

    expect(result.assignments.TRAEFIK_DASHBOARD_PORT).toBe(8080);
    expect(result.info).toEqual([expect.stringContaining('TRAEFIK_DASHBOARD_PORT=8080LEMONADE_URL=http://100.67.181.7:13305 is not a TCP port')]);
    expect(mockedIsPortAvailable).not.toHaveBeenCalledWith(Number.NaN);
    const written = readFileSync(envFile, 'utf-8');
    expect(written).toContain('TRAEFIK_DASHBOARD_PORT=8080\n');
    expect(written).not.toContain('NaN');

    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    ['', 8080],
    ['0', 8080],
    ['65536', 8080],
    ['8o8o', 8080],
    ['9090', 9090],
  ])('configuredPort(%j) → %i', (raw, expected) => {
    expect(configuredPort({ TRAEFIK_DASHBOARD_PORT: raw }, 'TRAEFIK_DASHBOARD_PORT', 8080)).toBe(expected);
  });

  it('does not throw when the env file does not exist yet, and creates it with resolved ports', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'ci-hub-ports-'));
    const envFile = path.join(tempDir, '.env.prod');

    expect(existsSync(envFile)).toBe(false);

    const result = resolveHubPorts(envFile);

    expect(result.assignments.HTTP_PORT).toBe(80);
    expect(result.assignments.HTTPS_PORT).toBe(443);
    expect(result.assignments.API_PORT).toBe(5002);
    expect(existsSync(envFile)).toBe(true);
    expect(readFileSync(envFile, 'utf-8')).toContain('HTTP_PORT=80');

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('stops running Hub stack containers before resolving dev ports', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'ci-hub-ports-'));
    const envFile = path.join(tempDir, '.env.dev');
    writeFileSync(envFile, ['HTTP_PORT=8880', 'HTTPS_PORT=8443', 'API_PORT=5002'].join('\n'));

    mockedSpawnSync.mockImplementation((command: string, args?: readonly string[]) => {
      const argv = args ?? [];
      if (command === 'docker' && argv[0] === 'ps' && argv.includes('status=running')) {
        return {
          status: 0,
          stdout: 'abc123\ttraefik\n',
          stderr: '',
          output: ['abc123\ttraefik\n', ''],
          pid: 0,
          signal: null,
        } as ReturnType<typeof spawnSync>;
      }
      return {
        status: 0,
        stdout: '',
        stderr: '',
        output: ['', ''],
        pid: 0,
        signal: null,
      } as ReturnType<typeof spawnSync>;
    });

    const result = healHubPortsBeforeStartup(envFile, () => undefined);

    expect(result.assignments.HTTP_PORT).toBe(8880);
    expect(mockedSpawnSync).toHaveBeenCalledWith('docker', ['rm', '-f', 'abc123'], expect.any(Object));

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not stop unrelated containers matched by Docker name substring filters', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'ci-hub-ports-'));
    const envFile = path.join(tempDir, '.env.dev');
    writeFileSync(envFile, ['HTTP_PORT=8880', 'HTTPS_PORT=8443', 'API_PORT=5002'].join('\n'));

    mockedSpawnSync.mockImplementation((command: string, args?: readonly string[]) => {
      const argv = args ?? [];
      if (command === 'docker' && argv[0] === 'ps' && argv.includes('status=running')) {
        return {
          status: 0,
          stdout: 'abc123\tmy-traefik-debug\n',
          stderr: '',
          output: ['abc123\tmy-traefik-debug\n', ''],
          pid: 0,
          signal: null,
        } as ReturnType<typeof spawnSync>;
      }
      return {
        status: 0,
        stdout: '',
        stderr: '',
        output: ['', ''],
        pid: 0,
        signal: null,
      } as ReturnType<typeof spawnSync>;
    });

    healHubPortsBeforeStartup(envFile, () => undefined);

    expect(mockedSpawnSync).not.toHaveBeenCalledWith('docker', ['rm', '-f', 'abc123'], expect.any(Object));

    rmSync(tempDir, { recursive: true, force: true });
  });
});
