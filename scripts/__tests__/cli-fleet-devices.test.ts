/**
 * `cihub fleet devices` — the command shape and the release flow, with Portal mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  login: null as unknown,
  listPortalDevices: vi.fn(),
  deletePortalDevice: vi.fn(),
  reRegisterPortalDevice: vi.fn(),
}));

vi.mock('../lib/catalog-submit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/catalog-submit.js')>()),
  readStoredLogin: () => mocks.login,
}));

vi.mock('../lib/fleet-devices.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-devices.js')>()),
  listPortalDevices: mocks.listPortalDevices,
  deletePortalDevice: mocks.deletePortalDevice,
  reRegisterPortalDevice: mocks.reRegisterPortalDevice,
}));

const { parseFleetArgs, runFleetCommand } = await import('../lib/cli-fleet.js');

const manage = { token: 'cio_m', orgId: 'org-1', orgSlug: 'bill-co', portalOrigin: 'https://portal.test', scope: 'device:manage' };

describe('parseFleetArgs devices', () => {
  it('reads the action and target positionals, then flags', () => {
    expect(parseFleetArgs(['devices', 'list', '--json'])).toMatchObject({ subcommand: 'devices', devicesAction: 'list', json: true });
    expect(parseFleetArgs(['devices', 'release', 'core-7', '--yes'])).toMatchObject({ devicesAction: 'release', devicesTarget: 'core-7', yes: true });
    expect(parseFleetArgs(['devices', 're-register', 'd1', '--org', 'org-2'])).toMatchObject({
      devicesAction: 're-register',
      devicesTarget: 'd1',
      org: 'org-2',
    });
  });

  it('refuses a missing or unknown action, and a release with no device', () => {
    expect(() => parseFleetArgs(['devices'])).toThrow(/needs an action/);
    expect(() => parseFleetArgs(['devices', 'nuke', 'x'])).toThrow(/needs an action/);
    expect(() => parseFleetArgs(['devices', 'release'])).toThrow(/needs a device/);
  });
});

describe('fleet devices release', () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    process.exitCode = undefined;
    mocks.login = manage;
    mocks.listPortalDevices.mockReset().mockResolvedValue([
      { id: 'd7', name: 'core-7', slug: 'core-7', status: 'active' },
      { id: 'd6', name: 'core-6', slug: 'core-6', status: 'active' },
    ]);
    mocks.deletePortalDevice.mockReset().mockResolvedValue({});
    mocks.reRegisterPortalDevice.mockReset().mockResolvedValue({ pairingCode: 'XYZ789', deviceId: 'd6' });
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(String(line));
    });
    vi.spyOn(console, 'error').mockImplementation((line: string) => {
      logs.push(String(line));
    });
  });
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("lists what Portal knows for the login's org", async () => {
    await runFleetCommand(['devices', 'list']);
    expect(mocks.listPortalDevices).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }));
    expect(logs.join('\n')).toMatch(/2 device\(s\) in bill-co/);
    expect(logs.join('\n')).toContain('core-7');
  });

  it('releases exactly the named device, by its Portal id, when confirmed with --yes', async () => {
    await runFleetCommand(['devices', 'release', 'core-7', '--yes']);
    expect(mocks.deletePortalDevice).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'd7' }));
    expect(logs.join('\n')).toMatch(/core-7 — released from bill-co/);
    expect(process.exitCode).toBeUndefined();
  });

  it('never deletes on a target that does not match exactly one device', async () => {
    await runFleetCommand(['devices', 'release', 'core', '--yes']);
    expect(mocks.deletePortalDevice).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('re-register prints the replacement code and the command to use it', async () => {
    await runFleetCommand(['devices', 're-register', 'core-6']);
    expect(mocks.reRegisterPortalDevice).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'd6' }));
    expect(logs.join('\n')).toContain('cihub register --code XYZ789');
  });

  it('refuses without a device:manage login, naming the login command, before dialling Portal', async () => {
    mocks.login = { ...manage, scope: 'device:pair' };
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    await expect(runFleetCommand(['devices', 'list'])).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(2);
    expect(logs.join('\n')).toMatch(/cihub login --scope device:manage/);
    expect(mocks.listPortalDevices).not.toHaveBeenCalled();
  });
});
