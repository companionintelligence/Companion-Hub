/**
 * `cihub fleet install` and a pairing code Portal has refused.
 *
 * The fleet run on 2026-09-22 minted a code per node, every node's `register` came back
 * `410 PAIRING_CODE_INVALID`, and the two retries that followed re-sent the very same codes —
 * "reusing the code minted 2026-09-22T06:34", the same timestamp all three times, even after every
 * device was released in Portal (CI-Hub#1582). The kept code was never dropped and nothing ever
 * minted a second. These tests pin both halves of the fix: the dead code is forgotten, and where the
 * login allows it a re-register puts a live one in its place.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  installNode: vi.fn(),
  mintPairingCode: vi.fn(),
  loginScope: vi.fn(),
  reRegisterPortalDevice: vi.fn(),
}));

vi.mock('../lib/fleet-roster.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-roster.js')>()),
  loadFleetRoster: () => ({ nodes: [{ name: 'beta-max', ip: '10.0.0.7' }], source: 'test-roster', dropped: [] }),
}));

vi.mock('../lib/catalog-submit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/catalog-submit.js')>()),
  readStoredLogin: () => ({ orgSlug: 'bill-co', orgId: 'org-1', token: 't', portalOrigin: 'https://portal.test', scope: mocks.loginScope() }),
  loginScope: () => mocks.loginScope(),
  mintPairingCode: mocks.mintPairingCode,
}));

vi.mock('../lib/fleet-devices.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-devices.js')>()),
  reRegisterPortalDevice: mocks.reRegisterPortalDevice,
}));

vi.mock('../lib/fleet-install.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-install.js')>()),
  installNode: mocks.installNode,
}));

const { runFleetCommand } = await import('../lib/cli-fleet.js');

type InstallOpts = import('../lib/fleet-install.js').InstallOptions;

let configHome: string;
const savedXdg = process.env.XDG_CONFIG_HOME;
const savedTokens = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
const storePath = () => join(configHome, 'cihub', 'fleet-pending-pairing-codes.json');
const readStore = () =>
  JSON.parse(readFileSync(storePath(), 'utf8')) as { codes: Record<string, { pairingCode: string }>; reRegistered: Record<string, unknown> };

/** Attempt one: mint, then `register` refuses the code and the caller is asked for a replacement. */
function refusedOnce(kind: 'refused' | 'claimed' = 'refused'): {
  replacement: () => Awaited<ReturnType<NonNullable<InstallOpts['replacePairingCode']>>> | undefined;
  refusal: () => string;
} {
  let replacement: { code: string; detail: string } | undefined;
  let refusal = '';
  mocks.installNode.mockImplementationOnce(async (node: { name: string }, opts: InstallOpts) => {
    await opts.mintPairingCode?.();
    try {
      replacement = await opts.replacePairingCode?.({ kind, why: 'Portal refused the code' });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    return { node: node.name, ok: false, steps: [] };
  });
  return { replacement: () => replacement, refusal: () => refusal };
}

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), 'cihub-xdg-'));
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.CIHUB_POSTGRES_PASSWORD = 'a-long-enough-password';
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.installNode.mockReset();
  mocks.loginScope.mockReset().mockReturnValue('device:manage');
  mocks.mintPairingCode.mockReset().mockResolvedValue({ pairingCode: 'DEAD01', deviceId: 'dev-1', slug: 'beta-max', name: 'beta-max' });
  mocks.reRegisterPortalDevice.mockReset().mockResolvedValue({ pairingCode: 'FRESH1', deviceId: 'dev-1' });
});

afterEach(() => {
  process.exitCode = undefined;
  delete process.env.CIHUB_POSTGRES_PASSWORD;
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  for (const [name, value] of Object.entries(savedTokens)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(configHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('a code Portal refused', () => {
  it('is re-registered for a live one, which is kept in its place', async () => {
    const seen = refusedOnce();
    await runFleetCommand(['install', '--execute']);

    expect(mocks.reRegisterPortalDevice).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'dev-1' }));
    expect(seen.replacement()).toMatchObject({ code: 'FRESH1' });
    // Kept, so a retry of the run sends the live code rather than minting a third.
    expect(readStore().codes['10.0.0.7']).toMatchObject({ pairingCode: 'FRESH1', name: 'beta-max' });
  });

  it('is forgotten even when no replacement can be had, so the next run never sends it again', async () => {
    mocks.loginScope.mockReturnValue('device:pair');
    const seen = refusedOnce();
    await runFleetCommand(['install', '--execute']);

    expect(mocks.reRegisterPortalDevice).not.toHaveBeenCalled();
    expect(seen.refusal()).toContain('device:manage');
    expect(readStore().codes).toEqual({});

    // The next run: nothing kept, so it mints — which is the whole point. Three runs in a row sent
    // the same dead code because this store still held it.
    mocks.installNode.mockImplementationOnce(async (node: { name: string }, opts: InstallOpts) => {
      const minted = await opts.mintPairingCode?.();
      expect(minted?.detail).not.toMatch(/reusing/);
      return { node: node.name, ok: false, steps: [] };
    });
    await runFleetCommand(['install', '--execute']);
    expect(mocks.mintPairingCode).toHaveBeenCalledTimes(2);
  });
});

describe('a code Portal claimed and then failed on', () => {
  it('is forgotten, and no replacement is minted to meet the same failure', async () => {
    const seen = refusedOnce('claimed');
    await runFleetCommand(['install', '--execute']);

    expect(mocks.reRegisterPortalDevice).not.toHaveBeenCalled();
    expect(seen.refusal()).toMatch(/spent/);
    expect(readStore().codes).toEqual({});
  });
});
