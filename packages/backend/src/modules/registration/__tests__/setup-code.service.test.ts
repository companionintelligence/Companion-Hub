import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSetupCode, normaliseSetupCode, SetupCodeService } from '../setup-code.service';

describe('SetupCodeService', () => {
  let dataDir: string;
  let service: SetupCodeService;
  const logger = { info: vi.fn(), warn: vi.fn() };

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-code-'));
    service = new SetupCodeService({ getConfig: () => ({ directories: { dataDir } }) } as never, logger as never);
    logger.info.mockClear();
    logger.warn.mockClear();
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const written = async () => (await fs.readFile(path.join(dataDir, 'state', 'setup-code'), 'utf8')).trim();

  it('writes a code an unpaired Hub asks for, readable by the machine’s own user only, and keeps it across restarts', async () => {
    await service.ensure();
    const code = await written();

    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect((await fs.stat(path.join(dataDir, 'state', 'setup-code'))).mode & 0o777).toBe(0o600);

    // A restart keeps it, so a link `cihub setup-code` already printed still works.
    await service.ensure();
    expect(await written()).toBe(code);
    // Says where it is, never what it is.
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(code);
  });

  it('accepts the code as a person types it, and nothing else', async () => {
    await service.ensure();
    const code = await written();

    await expect(service.verify(code)).resolves.toBe(true);
    await expect(service.verify(code.toLowerCase().replace('-', ' '))).resolves.toBe(true);
    await expect(service.verify('')).resolves.toBe(false);
    await expect(service.verify(undefined)).resolves.toBe(false);
    await expect(service.verify(code === 'AAAA-AAAA' ? 'BBBB-BBBB' : 'AAAA-AAAA')).resolves.toBe(false);
  });

  it('accepts no code once the Hub is paired', async () => {
    await service.ensure();
    const code = await written();

    await service.retire();

    await expect(service.verify(code)).resolves.toBe(false);
    await expect(fs.access(path.join(dataDir, 'state', 'setup-code'))).rejects.toThrow();
  });

  it('refuses every code, the right one included, for 15 minutes after 10 wrong ones from anywhere', async () => {
    await service.ensure();
    const code = await written();
    const wrong = code === '0000-0000' ? '1111-1111' : '0000-0000';
    const start = 1_000_000;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(service.verify(wrong, start)).resolves.toBe(false);
    }
    await expect(service.verify(code, start + 1)).resolves.toBe(false);
    await expect(service.verify(code, start + 14 * 60_000)).resolves.toBe(false);
    await expect(service.verify(code, start + 15 * 60_000)).resolves.toBe(true);
  });
});

describe('setup code shape', () => {
  it('is 8 characters people can read back: no I, L, O or U', () => {
    for (let index = 0; index < 200; index += 1) {
      expect(generateSetupCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
  });

  it('reads O, I and L as the digits they look like', () => {
    expect(normaliseSetupCode('ab-cd oi lz')).toBe('ABCD011Z');
  });
});
