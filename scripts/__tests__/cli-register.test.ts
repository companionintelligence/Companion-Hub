/**
 * What `cihub register` does over `ssh -n`: no terminal, and an exit code an installer can read.
 *
 * Only the HTTP calls are stubbed. The pairing-code rules, the prompt gate and the exit codes stay
 * real, because those are the whole contract a fleet install depends on — a source grep for
 * `process.exit` would pass just as happily against a function that never reaches the line.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsi } from '../lib/cli-ui.js';

const mocks = vi.hoisted(() => ({
  hub: {
    deviceInfo: { device_id: 'dev-1', ci_cloud_url: 'https://portal.example.com' } as { device_id?: string; ci_cloud_url?: string },
    deviceInfoFails: false,
    prepareFresh: { success: true, message: 'cleared' },
    prepareFreshFails: false,
    status: { phase: 'unregistered', registered: false } as { phase: string; registered: boolean; degradedReasons?: string[] },
    driftDetected: false,
    prepareFreshCalls: 0,
  },
  deviceKey: undefined as string | undefined,
  localDeviceId: { value: 'local-dev-1', fails: false },
  submitPairingCode: vi.fn(async (_apiBase: string, _code: string, _deviceKey?: string) => ({
    success: true,
    domain: 'example.com',
    subdomain: 'hub',
  })),
}));

vi.mock('../public-web-cli.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-web-cli.js')>()),
  readHubApiKey: () => mocks.deviceKey,
}));

vi.mock('../lib/hub-context.js', () => ({
  resolveHubContext: (env: string) => ({ env, appliance: false, envFile: '.env.local', composeFiles: [] }),
  requireRepoOrApplianceContext: () => {},
}));

vi.mock('../lib/cli-repo-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cli-repo-context.js')>()),
  requireRepoRoot: () => {},
}));

vi.mock('../env-file.js', () => ({ parseEnvFile: () => ({}) }));

vi.mock('../get-device-id.js', () => ({
  getDeviceId: async () => {
    if (mocks.localDeviceId.fails) throw new Error('no hardware id');
    return mocks.localDeviceId.value;
  },
}));

// Partial: the pairing-code helpers are the rules under test, so stubbing them would test the stub.
vi.mock('../lib/register-hub.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/register-hub.js')>()),
  resolveRegisterApiBase: () => 'http://localhost:3001',
  waitForHubApi: async () => true,
  fetchRegistrationStatus: async () => mocks.hub.status,
  fetchStateDrift: async () => ({ detected: mocks.hub.driftDetected }),
  prepareFreshSetup: async () => {
    mocks.hub.prepareFreshCalls++;
    if (mocks.hub.prepareFreshFails) throw new Error('backend refused');
    return mocks.hub.prepareFresh;
  },
  fetchDeviceId: async () => {
    if (mocks.hub.deviceInfoFails) throw new Error('connection refused');
    return mocks.hub.deviceInfo;
  },
  submitPairingCode: mocks.submitPairingCode,
  pollRegistrationComplete: async () => ({ phase: 'publicly_ready', registered: true }),
}));

import { registerHub, resolvePairingCode, showDeviceId } from '../lib/cli-register.js';

let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

const output = () => (logSpy.mock.calls as unknown[][]).map((call) => stripAnsi(String(call[0]))).join('\n');

beforeEach(() => {
  mocks.hub.deviceInfo = { device_id: 'dev-1', ci_cloud_url: 'https://portal.example.com' };
  mocks.hub.deviceInfoFails = false;
  mocks.hub.prepareFresh = { success: true, message: 'cleared' };
  mocks.hub.prepareFreshFails = false;
  mocks.hub.status = { phase: 'unregistered', registered: false };
  mocks.hub.driftDetected = false;
  mocks.hub.prepareFreshCalls = 0;
  mocks.deviceKey = undefined;
  mocks.localDeviceId.fails = false;
  mocks.submitPairingCode.mockClear();
  // The runner's stdin is already a pipe; pinning it keeps "no terminal" a property of the test.
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number): never => {
    throw new Error(`exit ${code ?? 0}`);
  }) as never);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  logSpy.mockRestore();
  if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
});

describe('cihub register without a terminal', () => {
  /**
   * The defect: an unguarded readline loop on a closed stdin never settled, so the command hung and
   * then exited 0 having registered nothing. Without the guard this test does not fail loudly — it
   * hangs until vitest kills it, which is exactly the fleet symptom.
   */
  it('refuses with the flag that works unattended instead of prompting', async () => {
    await expect(registerHub('local')).rejects.toThrow('exit 2');
    expect(output()).toContain('--code');
  });

  it('pairs with a code passed on the command line, normalizing it first', async () => {
    await expect(registerHub('local', { code: ' ab-12cd ' })).resolves.toBeUndefined();
    expect(mocks.submitPairingCode).toHaveBeenCalledWith('http://localhost:3001', 'AB12CD', undefined);
  });

  it('names the env it was invoked for so the suggested command is copy-pasteable', async () => {
    await expect(resolvePairingCode('prod', undefined, false)).rejects.toThrow('exit 2');
    expect(output()).toContain('register prod --code <code>');
  });
});

describe('cihub register exit codes', () => {
  it('exits non-zero when device info cannot be read', async () => {
    mocks.hub.deviceInfoFails = true;
    await expect(registerHub('local', { code: 'AB12CD' })).rejects.toThrow('exit 1');
    expect(output()).toContain('Device info failed');
  });

  it('exits non-zero on a malformed --code', async () => {
    await expect(registerHub('local', { code: 'nope' })).rejects.toThrow('exit 2');
    expect(mocks.submitPairingCode).not.toHaveBeenCalled();
  });

  it('exits non-zero when clearing drifted state fails', async () => {
    mocks.hub.prepareFresh = { success: false, message: 'still locked' };
    await expect(registerHub('local', { fresh: true, code: 'AB12CD' })).rejects.toThrow('exit 1');

    mocks.hub.prepareFreshFails = true;
    await expect(registerHub('local', { fresh: true, code: 'AB12CD' })).rejects.toThrow('exit 1');
    expect(mocks.submitPairingCode).not.toHaveBeenCalled();
  });

  it('exits non-zero when the Hub resolves no device id', async () => {
    mocks.hub.deviceInfo = { device_id: '' };
    await expect(registerHub('local', { code: 'AB12CD' })).rejects.toThrow('exit 1');
  });
});

describe('cihub register on a Hub that is registered and needs pairing again', () => {
  beforeEach(() => {
    mocks.hub.status = { phase: 'degraded', registered: true, degradedReasons: ['portal_rejected'] };
  });

  // The Hub re-pairs a registered Hub only for an authenticated caller, so without the host-local
  // key the remedy for a Portal-rejected key would be refused by the Hub it runs on.
  it('sends the host-local device key with the code', async () => {
    mocks.deviceKey = 'host-local-key';

    await expect(registerHub('local', { code: 'AB12CD' })).resolves.toBeUndefined();

    expect(mocks.submitPairingCode).toHaveBeenCalledWith('http://localhost:3001', 'AB12CD', 'host-local-key');
  });

  it('does not try to clear drifted state first, which the Hub refuses while registered and would exit 1', async () => {
    mocks.hub.driftDetected = true;

    await expect(registerHub('local', { code: 'AB12CD' })).resolves.toBeUndefined();

    expect(mocks.hub.prepareFreshCalls).toBe(0);
    expect(mocks.submitPairingCode).toHaveBeenCalledTimes(1);
  });
});

describe('cihub device-id', () => {
  it('exits non-zero from the local lookup, matching --from-hub', async () => {
    mocks.localDeviceId.fails = true;
    await expect(showDeviceId()).rejects.toThrow('exit 1');
    expect(output()).toContain('Device ID lookup failed');
  });

  it('prints the id and exits cleanly when the lookup works', async () => {
    await expect(showDeviceId()).resolves.toBeUndefined();
    expect(output()).toContain('local-dev-1');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
