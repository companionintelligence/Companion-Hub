import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseEnvFile, upsertEnvVar } from '../env-file';

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
