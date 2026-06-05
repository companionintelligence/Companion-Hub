import fs from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { quarantineStalePath, readTextFileIfExists, writeHealableTextFile } from '../bind-mount-helpers';

describe('bind-mount-helpers', () => {
  const tmpRoot = join(process.cwd(), '.tmp-bind-mount-helpers-test');

  beforeEach(() => {
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  it('writes a new file in a writable directory', async () => {
    const filePath = join(tmpRoot, 'token');
    await writeHealableTextFile(filePath, 'test-token');
    expect(readTextFileIfExists(filePath)).toBe('test-token');
  });

  it('quarantines a read-only stale file and preserves content for recovery', async () => {
    const filePath = join(tmpRoot, 'hub.yml');
    fs.writeFileSync(filePath, 'stale: true\n', 'utf-8');
    fs.chmodSync(filePath, 0o400);
    vi.spyOn(fs.promises, 'chmod').mockImplementation(async (targetPath) => {
      if (String(targetPath) === filePath) {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
    });

    await writeHealableTextFile(filePath, 'http:\n  routers: {}\n');
    const names = fs.readdirSync(tmpRoot);
    expect(names.some((name) => /^hub\.yml\.stale-root-/.test(name))).toBe(true);
    expect(readTextFileIfExists(filePath)).toContain('routers');
  });

  it('quarantineStalePath preserves original file contents', () => {
    const filePath = join(tmpRoot, 'token');
    fs.writeFileSync(filePath, 'secret-token', 'utf-8');
    const quarantinePath = quarantineStalePath(filePath);
    expect(quarantinePath).toBeTruthy();
    if (!quarantinePath) return;
    expect(fs.readFileSync(quarantinePath, 'utf-8')).toBe('secret-token');
    expect(readTextFileIfExists(filePath)).toBeNull();
  });
});
