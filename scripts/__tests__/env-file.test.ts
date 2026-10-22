import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseEnvFile, removeEnvVar, restrictEnvFileMode, upsertEnvVar } from '../env-file';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'env-file-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseEnvFile', () => {
  it('treats a missing file as empty instead of throwing', () => {
    const missing = path.join(dir, '.env.prod');
    expect(existsSync(missing)).toBe(false);
    expect(parseEnvFile(missing)).toEqual({});
  });
});

describe('upsertEnvVar', () => {
  it('creates the file when it does not exist yet', () => {
    const p = path.join(dir, '.env.prod');
    expect(existsSync(p)).toBe(false);

    upsertEnvVar(p, 'HTTP_PORT', '80');

    expect(parseEnvFile(p).HTTP_PORT).toBe('80');
  });

  it('does not leave a blank line between entries when building up a fresh file one key at a time', () => {
    // Mirrors resolveHubPorts's upsertEnvPorts: several sequential upsertEnvVar calls against a
    // file that did not exist before the first one.
    const p = path.join(dir, '.env.prod');

    upsertEnvVar(p, 'HTTP_PORT', '80');
    upsertEnvVar(p, 'HTTPS_PORT', '443');
    upsertEnvVar(p, 'API_PORT', '5002');

    expect(readFileSync(p, 'utf-8')).toBe('HTTP_PORT=80\nHTTPS_PORT=443\nAPI_PORT=5002\n');
  });

  it('replaces an existing key in place rather than appending a duplicate', () => {
    const p = path.join(dir, '.env.prod');
    upsertEnvVar(p, 'API_PORT', '5002');
    upsertEnvVar(p, 'HTTPS_PORT', '443');

    upsertEnvVar(p, 'API_PORT', '5003');

    expect(readFileSync(p, 'utf-8')).toBe('API_PORT=5003\nHTTPS_PORT=443\n');
  });
});

/**
 * A Hub env file holds JWT_SECRET, POSTGRES_PASSWORD and RABBITMQ_PASSWORD. writeFileSync's `mode`
 * only applies when it creates the file, so a file first written at the umask's 0664 used to keep
 * that mode through every cihub write.
 */
describe.skipIf(process.platform === 'win32')('env file mode', () => {
  const modeOf = (p: string) => statSync(p).mode & 0o777;

  it('creates a new env file at 0600, whatever the umask', () => {
    const p = path.join(dir, '.env.prod');
    const previous = process.umask(0o002);
    try {
      upsertEnvVar(p, 'HTTP_PORT', '80');
    } finally {
      process.umask(previous);
    }
    expect(modeOf(p)).toBe(0o600);
  });

  it('takes group and other bits off an existing 0664 file it writes', () => {
    const p = path.join(dir, '.env.dev');
    writeFileSync(p, 'POSTGRES_PASSWORD=x\n');
    chmodSync(p, 0o664);

    upsertEnvVar(p, 'DOCKER_GID', '981');

    expect(modeOf(p)).toBe(0o600);
    expect(readFileSync(p, 'utf-8')).toBe('POSTGRES_PASSWORD=x\nDOCKER_GID=981\n');
  });

  it('restricts the file even when the value is already there and nothing is rewritten', () => {
    const p = path.join(dir, '.env.dev');
    writeFileSync(p, 'DOCKER_GID=981\n');
    chmodSync(p, 0o644);

    upsertEnvVar(p, 'DOCKER_GID', '981');

    expect(modeOf(p)).toBe(0o600);
    expect(readFileSync(p, 'utf-8')).toBe('DOCKER_GID=981\n');
  });

  it('restricts on removeEnvVar too', () => {
    const p = path.join(dir, '.env.prod');
    writeFileSync(p, 'CI_HUB_CONTAINER_UID=1000\nJWT_SECRET=y\n');
    chmodSync(p, 0o664);

    removeEnvVar(p, 'CI_HUB_CONTAINER_UID');

    expect(modeOf(p)).toBe(0o600);
    expect(readFileSync(p, 'utf-8')).toBe('JWT_SECRET=y\n');
  });

  it('never adds a bit: a 0400 file stays 0400 and reports no change', () => {
    const p = path.join(dir, '.env.dev');
    writeFileSync(p, 'JWT_SECRET=y\n');
    chmodSync(p, 0o400);

    expect(restrictEnvFileMode(p)).toBeUndefined();
    expect(modeOf(p)).toBe(0o400);
  });

  it('reports the mode it replaced', () => {
    const p = path.join(dir, '.env');
    writeFileSync(p, 'JWT_SECRET=y\n');
    chmodSync(p, 0o664);

    expect(restrictEnvFileMode(p)).toBe(0o664);
    expect(modeOf(p)).toBe(0o600);
  });

  it('leaves the mode alone when CI_HUB_CONTAINER_UID pins the Hub to another non-root uid', () => {
    // The Hub reads /data/.env as that uid, through the other bits.
    const p = path.join(dir, '.env.prod');
    const other = (process.getuid?.() ?? 1000) + 1;
    writeFileSync(p, `CI_HUB_CONTAINER_UID=${other}\nJWT_SECRET=y\n`);
    chmodSync(p, 0o644);

    expect(restrictEnvFileMode(p)).toBeUndefined();
    expect(modeOf(p)).toBe(0o644);
  });

  it('still restricts when the pin is root or the file owner', () => {
    const p = path.join(dir, '.env.prod');
    for (const pin of ['0', String(process.getuid?.() ?? 1000)]) {
      writeFileSync(p, `CI_HUB_CONTAINER_UID=${pin}\nJWT_SECRET=y\n`);
      chmodSync(p, 0o664);
      expect(restrictEnvFileMode(p)).toBe(0o664);
      expect(modeOf(p)).toBe(0o600);
    }
  });

  it('leaves a missing file missing', () => {
    const p = path.join(dir, '.env');
    expect(restrictEnvFileMode(p)).toBeUndefined();
    expect(existsSync(p)).toBe(false);
  });
});
