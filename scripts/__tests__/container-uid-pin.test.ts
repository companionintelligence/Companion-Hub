import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseEnvFile, removeEnvVar, upsertEnvVar } from '../env-file';

/**
 * `CI_HUB_CONTAINER_UID` must not be pinned in the env file when the entrypoint can derive
 * it. The pin is what made #1370 and #1378 inert across the whole fleet: every node carried
 * `CI_HUB_CONTAINER_UID=1000` in .env.prod, so the container dropped to 1000 regardless of
 * who owned the install, and a root-owned one crash-looped on its own 0600 /data/.env.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'uid-pin-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function envFile(contents: string): string {
  const p = path.join(dir, '.env.prod');
  writeFileSync(p, contents, 'utf-8');
  return p;
}

describe('removeEnvVar', () => {
  it('drops the pin and leaves every other line untouched', () => {
    const p = envFile('# header\nDOCKER_GID=973\nCI_HUB_CONTAINER_UID=1000\nPOSTGRES_PASSWORD=hunter2\n');

    removeEnvVar(p, 'CI_HUB_CONTAINER_UID');

    expect(readFileSync(p, 'utf-8')).toBe('# header\nDOCKER_GID=973\nPOSTGRES_PASSWORD=hunter2\n');
  });

  it('is a no-op when the variable is absent, rather than rewriting the file', () => {
    const original = '# header\nDOCKER_GID=973\n';
    const p = envFile(original);

    removeEnvVar(p, 'CI_HUB_CONTAINER_UID');

    expect(readFileSync(p, 'utf-8')).toBe(original);
  });

  it('leaves a commented-out line alone, since it pins nothing', () => {
    const p = envFile('# CI_HUB_CONTAINER_UID=1000\nDOCKER_GID=973\n');

    removeEnvVar(p, 'CI_HUB_CONTAINER_UID');

    expect(readFileSync(p, 'utf-8')).toContain('# CI_HUB_CONTAINER_UID=1000');
  });

  it('actually unpins: upsert then remove leaves nothing for compose to read', () => {
    const p = envFile('DOCKER_GID=973\n');

    upsertEnvVar(p, 'CI_HUB_CONTAINER_UID', '1000');
    expect(parseEnvFile(p).CI_HUB_CONTAINER_UID).toBe('1000');

    removeEnvVar(p, 'CI_HUB_CONTAINER_UID');
    // Not '' and not '0' — absent. Compose renders `${VAR:-}` empty and the entrypoint derives.
    expect(parseEnvFile(p).CI_HUB_CONTAINER_UID).toBeUndefined();
  });

  it('does not touch a variable that merely shares a prefix', () => {
    const p = envFile('CI_HUB_CONTAINER_UID=1000\nCI_HUB_CONTAINER_UID_OVERRIDE=7\n');

    removeEnvVar(p, 'CI_HUB_CONTAINER_UID');

    expect(parseEnvFile(p).CI_HUB_CONTAINER_UID_OVERRIDE).toBe('7');
    expect(parseEnvFile(p).CI_HUB_CONTAINER_UID).toBeUndefined();
  });
});
