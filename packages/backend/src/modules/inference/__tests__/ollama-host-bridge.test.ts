import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  dockerHostCurl,
  isBridgeConnectionRefused,
  isConnectionRefused,
  isRunningInDocker,
  probeHostNetworkOllama,
  shouldTryHostNetworkBridge,
} from '../backends/ollama-host-bridge';

vi.mock('node:fs');
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

describe('ollama-host-bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isRunningInDocker', () => {
    it('returns true when /.dockerenv exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(isRunningInDocker()).toBe(true);
    });

    it('returns false when not in a container', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(isRunningInDocker()).toBe(false);
    });
  });

  describe('isConnectionRefused', () => {
    it('detects ECONNREFUSED errors', () => {
      expect(isConnectionRefused(new Error('connect ECONNREFUSED 172.17.0.1:11434'))).toBe(true);
      expect(isConnectionRefused(new Error('timeout'))).toBe(false);
    });
  });

  describe('isBridgeConnectionRefused', () => {
    it('detects bridge ECONNREFUSED errors', () => {
      expect(isBridgeConnectionRefused('connect ECONNREFUSED 172.17.0.1:11434')).toBe(true);
      expect(isBridgeConnectionRefused('timeout')).toBe(false);
    });
  });

  describe('shouldTryHostNetworkBridge', () => {
    it('returns true for bridge URL failures inside Docker', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(shouldTryHostNetworkBridge('http://host.docker.internal:11434', new Error('connect ECONNREFUSED'))).toBe(true);
    });

    it('returns false outside Docker', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(shouldTryHostNetworkBridge('http://host.docker.internal:11434', new Error('connect ECONNREFUSED'))).toBe(false);
    });
  });

  describe('dockerHostCurl', () => {
    it('runs curl in a host-network container', async () => {
      const stdoutHandlers: Array<(chunk: Buffer) => void> = [];
      const closeHandlers: Array<(code: number) => void> = [];

      vi.mocked(spawn).mockReturnValue({
        stdout: {
          on: vi.fn((event: string, handler: (chunk: Buffer) => void) => {
            if (event === 'data') stdoutHandlers.push(handler);
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, handler: (code: number) => void) => {
          if (event === 'close') closeHandlers.push(handler);
        }),
        kill: vi.fn(),
      } as unknown as ReturnType<typeof spawn>);

      const promise = dockerHostCurl('GET', '/api/tags', undefined, { timeoutMs: 5000 });
      stdoutHandlers[0]?.(Buffer.from('{"models":[]}'));
      closeHandlers[0]?.(0);

      await expect(promise).resolves.toBe('{"models":[]}');
      expect(spawn).toHaveBeenCalledWith('docker', expect.arrayContaining(['run', '--rm', '-i', '--network', 'host', 'curlimages/curl:8.12.1']));
    });
  });

  describe('probeHostNetworkOllama', () => {
    it('returns true when host-network curl succeeds', async () => {
      const stdoutHandlers: Array<(chunk: Buffer) => void> = [];
      const closeHandlers: Array<(code: number) => void> = [];

      vi.mocked(spawn).mockReturnValue({
        stdout: {
          on: vi.fn((event: string, handler: (chunk: Buffer) => void) => {
            if (event === 'data') stdoutHandlers.push(handler);
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, handler: (code: number) => void) => {
          if (event === 'close') closeHandlers.push(handler);
        }),
        kill: vi.fn(),
      } as unknown as ReturnType<typeof spawn>);

      const promise = probeHostNetworkOllama();
      stdoutHandlers[0]?.(Buffer.from('{"models":[]}'));
      closeHandlers[0]?.(0);

      await expect(promise).resolves.toBe(true);
    });
  });
});
