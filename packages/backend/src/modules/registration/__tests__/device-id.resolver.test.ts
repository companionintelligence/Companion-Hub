import fs from 'node:fs';
import { vol } from 'memfs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeDeviceIdCandidate, resolveDeviceId } from '../device-id.resolver';

describe('device-id.resolver', () => {
  const dataDir = '/data';

  beforeEach(() => {
    vol.reset();
    vol.fromJSON({ [`${dataDir}/state/.keep`]: '' });
    delete process.env.DEVICE_ID;
  });

  afterEach(() => {
    vol.reset();
  });

  describe('normalizeDeviceIdCandidate', () => {
    it('rejects empty and placeholder values', () => {
      expect(normalizeDeviceIdCandidate('')).toBeNull();
      expect(normalizeDeviceIdCandidate('Not Specified')).toBeNull();
      expect(normalizeDeviceIdCandidate('00000000-0000-0000-0000-000000000000')).toBeNull();
    });

    it('accepts usable identifiers', () => {
      expect(normalizeDeviceIdCandidate('  abc-123  ')).toBe('abc-123');
    });
  });

  describe('resolveDeviceId', () => {
    it('prefers DEVICE_ID env var', async () => {
      process.env.DEVICE_ID = 'env-device-id';

      await expect(resolveDeviceId({ dataDir })).resolves.toBe('env-device-id');
    });

    it('falls back to dmidecode serial when env is unset', async () => {
      const execCommand = vi.fn().mockReturnValue('HW-SERIAL-123');

      await expect(resolveDeviceId({ dataDir, execCommand: execCommand as never })).resolves.toBe('HW-SERIAL-123');
    });

    it('uses systeminformation os uuid when hardware uuid is empty', async () => {
      const execCommand = vi.fn().mockImplementation(() => {
        throw new Error('no dmidecode');
      });
      const readUuid = vi.fn().mockResolvedValue({ hardware: '', os: 'os-uuid-456' });

      await expect(resolveDeviceId({ dataDir, execCommand: execCommand as never, readUuid })).resolves.toBe('os-uuid-456');
    });

    it('creates and reuses a generated fallback when no hardware source is available', async () => {
      const execCommand = vi.fn().mockImplementation(() => {
        throw new Error('no dmidecode');
      });
      const readUuid = vi.fn().mockResolvedValue({ hardware: '', os: '' });

      const first = await resolveDeviceId({ dataDir, execCommand: execCommand as never, readUuid });
      const second = await resolveDeviceId({ dataDir, execCommand: execCommand as never, readUuid });

      expect(first).toMatch(/^generated-[0-9a-f-]{36}$/);
      expect(second).toBe(first);
      expect(fs.readFileSync(`${dataDir}/state/generated-device-id`, 'utf-8').trim()).toBe(first);
    });

    it('never returns an empty string', async () => {
      const execCommand = vi.fn().mockReturnValue('   ');
      const readUuid = vi.fn().mockResolvedValue({ hardware: '00000000-0000-0000-0000-000000000000', os: '' });

      const deviceId = await resolveDeviceId({ dataDir, execCommand: execCommand as never, readUuid });
      expect(deviceId.length).toBeGreaterThan(0);
    });
  });
});
