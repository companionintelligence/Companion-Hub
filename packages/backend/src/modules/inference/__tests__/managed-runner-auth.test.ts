import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bearerHeaders, readManagedRunnerApiKey } from '../managed-runner-auth';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('managed runner authentication', () => {
  it('prefers an explicit environment key over desktop-managed state', () => {
    expect(readManagedRunnerApiKey('dspark', { DSPARK_API_KEY: ' operator-key ' }, '/missing')).toBe('operator-key');
  });

  it('reads the private key shared through the Hub state mount', () => {
    const dataDir = '/ci-hub-runner-auth-test';
    temporaryDirectories.push(dataDir);
    const stateDir = path.join(dataDir, 'state', 'inference-runners');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'mtplx.api-key'), 'managed-key\n');

    expect(readManagedRunnerApiKey('mtplx', {}, dataDir)).toBe('managed-key');
  });

  it('omits authentication when no key has been configured', () => {
    expect(readManagedRunnerApiKey('dspark', {}, '/missing')).toBeUndefined();
    expect(bearerHeaders(undefined)).toBeUndefined();
    expect(bearerHeaders('secret')).toEqual({ Authorization: 'Bearer secret' });
  });
});
