/**
 * `cihub fleet devices` — the command shape, the release flow, and what a re-register leaves behind
 * for `fleet install`, with Portal mocked.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  login: null as unknown,
  roster: [] as { name: string; ip: string }[],
  listPortalDevices: vi.fn(),
  deletePortalDevice: vi.fn(),
  reRegisterPortalDevice: vi.fn(),
}));

vi.mock('../lib/catalog-submit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/catalog-submit.js')>()),
  readStoredLogin: () => mocks.login,
}));

vi.mock('../lib/fleet-roster.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-roster.js')>()),
  loadFleetRoster: () => ({ nodes: mocks.roster, source: 'test-roster', dropped: [] }),
}));

vi.mock('../lib/fleet-devices.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-devices.js')>()),
  listPortalDevices: mocks.listPortalDevices,
  deletePortalDevice: mocks.deletePortalDevice,
  reRegisterPortalDevice: mocks.reRegisterPortalDevice,
}));

const { parseFleetArgs, runFleetCommand } = await import('../lib/cli-fleet.js');

const manage = { token: 'cio_m', orgId: 'org-1', orgSlug: 'bill-co', portalOrigin: 'https://portal.test', scope: 'device:manage' };

// The pending-codes store lives beside the Portal login, so every test gets its own config dir:
// a re-register writes there, and the first version of this file wrote a fake core-6 into the
// developer's real one.
let configHome: string;
const savedXdg = process.env.XDG_CONFIG_HOME;
const storePath = () => join(configHome, 'cihub', 'fleet-pending-pairing-codes.json');

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
    configHome = mkdtempSync(join(tmpdir(), 'cihub-xdg-'));
    process.env.XDG_CONFIG_HOME = configHome;
    mocks.login = manage;
    mocks.roster = [];
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
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    rmSync(configHome, { recursive: true, force: true });
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

  it('re-register replaces the code fleet install kept for the roster node of that name', async () => {
    // core-1 on 2026-09-20: install had kept a code, re-register minted a newer one, the next
    // install reused the old one and failed at register. The kept one must be the new one.
    const { readPendingPairingCode, savePendingPairingCode } = await import('../lib/fleet-pairing-codes.js');
    mocks.roster = [
      { name: 'core-6', ip: '10.0.0.6' },
      { name: 'core-7', ip: '10.0.0.7' },
    ];
    savePendingPairingCode({
      ip: '10.0.0.6',
      name: 'core-6',
      slug: 'core-6',
      deviceId: 'd6',
      pairingCode: 'OLD666',
      orgId: 'org-1',
      mintedAt: '2026-09-19T17:19:00Z',
    });
    savePendingPairingCode({
      ip: '10.0.0.7',
      name: 'core-7',
      slug: 'core-7',
      deviceId: 'd7',
      pairingCode: 'KEEP77',
      orgId: 'org-1',
      mintedAt: '2026-09-19T17:20:00Z',
    });

    await runFleetCommand(['devices', 're-register', 'core-6']);

    expect(readPendingPairingCode('10.0.0.6', 'org-1')).toMatchObject({ name: 'core-6', pairingCode: 'XYZ789', deviceId: 'd6', orgId: 'org-1' });
    expect(readPendingPairingCode('10.0.0.6', 'org-1')?.reRegisteredAt).toBeTruthy();
    expect(readPendingPairingCode('10.0.0.7', 'org-1')?.pairingCode).toBe('KEEP77');
    expect(logs.join('\n')).toMatch(/fleet install --nodes core-6 --execute, which reuses this code in place of the one kept 2026-09-19T17:19/);
    const store = JSON.parse(readFileSync(storePath(), 'utf8'));
    expect(Object.values(store.reRegistered)).toEqual([expect.objectContaining({ name: 'core-6', deviceId: 'd6', orgId: 'org-1' })]);
  });

  it('re-register keeps the code for the roster node even when install had kept none', async () => {
    const { readPendingPairingCode } = await import('../lib/fleet-pairing-codes.js');
    mocks.roster = [{ name: 'core-6', ip: '10.0.0.6' }];
    await runFleetCommand(['devices', 're-register', 'core-6']);
    expect(readPendingPairingCode('10.0.0.6', 'org-1')?.pairingCode).toBe('XYZ789');
    expect(logs.join('\n')).toMatch(/fleet install --nodes core-6 --execute, which reuses this code$/m);
  });

  it('re-register says so when no roster node carries the device name, and still records the re-register', async () => {
    mocks.roster = [{ name: 'core-7', ip: '10.0.0.7' }];
    await runFleetCommand(['devices', 're-register', 'core-6']);
    expect(logs.join('\n')).toMatch(/no roster node is named core-6, so the code was kept for none; pass it to the next fleet install with --code/);
    const store = JSON.parse(readFileSync(storePath(), 'utf8'));
    expect(store.codes).toEqual({});
    expect(Object.values(store.reRegistered)).toHaveLength(1);
    expect(process.exitCode).toBeUndefined();
  });

  it('re-register keeps the code under --org, so a login for another org never reuses it', async () => {
    const { readPendingPairingCode } = await import('../lib/fleet-pairing-codes.js');
    mocks.roster = [{ name: 'core-6', ip: '10.0.0.6' }];
    await runFleetCommand(['devices', 're-register', 'core-6', '--org', 'org-2']);
    expect(readPendingPairingCode('10.0.0.6', 'org-1')).toBeUndefined();
    expect(readPendingPairingCode('10.0.0.6', 'org-2')?.pairingCode).toBe('XYZ789');
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
