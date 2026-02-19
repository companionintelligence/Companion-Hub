import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock child_process before importing the service
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  constants: { X_OK: 1, R_OK: 4, W_OK: 2 },
}));

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { TailscaleService } from '../tailscale.service';

const mockExecFile = vi.mocked(execFile);
const mockAccess = vi.mocked(access);

describe('TailscaleService', () => {
  let service: TailscaleService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TailscaleService();
  });

  describe('isInstalled', () => {
    it('returns true when binary exists', async () => {
      mockAccess.mockResolvedValue(undefined);
      expect(await service.isInstalled()).toBe(true);
    });

    it('returns false when binary does not exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      expect(await service.isInstalled()).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('returns not-installed when binary missing', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      const status = await service.getStatus();
      expect(status.installed).toBe(false);
      expect(status.connected).toBe(false);
    });

    it('parses connected status from tailscale status --json', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(
          null,
          JSON.stringify({
            Version: '1.88.0',
            BackendState: 'Running',
            Self: {
              HostName: 'ci-hub',
              TailscaleIPs: ['100.64.0.1'],
            },
            CurrentTailnet: {
              Name: 'example.ts.net',
            },
          }),
          '',
        );
        return {} as any;
      });

      const status = await service.getStatus();
      expect(status.installed).toBe(true);
      expect(status.connected).toBe(true);
      expect(status.hostname).toBe('ci-hub');
      expect(status.tailnet).toBe('example.ts.net');
      expect(status.ip).toBe('100.64.0.1');
      expect(status.supportsServices).toBe(true);
      expect(status.version).toBe('1.88.0');
    });

    it('detects services support based on version', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(
          null,
          JSON.stringify({
            Version: '1.80.0',
            BackendState: 'Running',
            Self: { HostName: 'test', TailscaleIPs: ['100.64.0.2'] },
            CurrentTailnet: { Name: 'test.ts.net' },
          }),
          '',
        );
        return {} as any;
      });

      const status = await service.getStatus();
      expect(status.supportsServices).toBe(false);
    });
  });
});
