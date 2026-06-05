import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTextFileIfExists, writeHealableTextFile } from '../bind-mount-helpers';

function resetTmpRoot(tmpRoot: string): void {
  execSync(`rm -rf ${JSON.stringify(tmpRoot)}`);
  execSync(`mkdir -p ${JSON.stringify(tmpRoot)}`);
}

describe('bind-mount-helpers', () => {
  const tmpRoot = join(process.cwd(), '.tmp-bind-mount-helpers-test');

  beforeEach(() => {
    resetTmpRoot(tmpRoot);
  });

  afterEach(() => {
    execSync(`rm -rf ${JSON.stringify(tmpRoot)}`);
  });

  it('writes a new file in a writable directory', async () => {
    const filePath = join(tmpRoot, 'token');
    await writeHealableTextFile(filePath, 'test-token');
    expect(readTextFileIfExists(filePath)).toBe('test-token');
  });

  it('replaces a read-only stale file by unlinking and rewriting', async () => {
    if (process.getuid?.() === 0) {
      return;
    }

    const filePath = join(tmpRoot, 'hub.yml');
    execSync(`printf 'stale: true\\n' > ${JSON.stringify(filePath)}`);
    execSync(`chmod 400 ${JSON.stringify(filePath)}`);

    await writeHealableTextFile(filePath, 'http:\n  routers: {}\n');
    expect(readTextFileIfExists(filePath)).toContain('routers');
  });
});
