/**
 * `cihub fleet install` and the Portal pairing code: minted last, kept until spent, reused on retry.
 *
 * The first fleet run minted first. Its first node then failed to download the binary, and the
 * retry got `409 a device named "beta-red" already exists` — the code was gone and the name was
 * taken. Nothing the CLI could do; a person had to delete the orphan in Portal. These tests pin the
 * three behaviours that make a retry possible.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  installNode: vi.fn(),
  mintPairingCode: vi.fn(),
}));

vi.mock('../lib/fleet-roster.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-roster.js')>()),
  loadFleetRoster: () => ({ nodes: [{ name: 'core-7', ip: '10.0.0.7' }], source: 'test-roster', dropped: [] }),
}));

vi.mock('../lib/catalog-submit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/catalog-submit.js')>()),
  readStoredLogin: () => ({ orgSlug: 'bill-co', orgId: 'org-1', token: 't', portalOrigin: 'https://portal.test', scope: 'device:pair' }),
  loginScope: () => 'device:pair',
  mintPairingCode: mocks.mintPairingCode,
}));

vi.mock('../lib/fleet-install.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-install.js')>()),
  installNode: mocks.installNode,
}));

const { runFleetCommand } = await import('../lib/cli-fleet.js');

let configHome: string;
const savedXdg = process.env.XDG_CONFIG_HOME;
const storePath = () => join(configHome, 'cihub', 'fleet-pending-pairing-codes.json');

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), 'cihub-xdg-'));
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.CIHUB_POSTGRES_PASSWORD = 'a-long-enough-password';
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.installNode.mockReset();
  mocks.mintPairingCode.mockReset().mockResolvedValue({ pairingCode: 'ABC123', deviceId: 'dev-1', slug: 'core-7', name: 'core-7' });
});

afterEach(() => {
  process.exitCode = undefined;
  delete process.env.CIHUB_POSTGRES_PASSWORD;
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(configHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

type InstallOpts = import('../lib/fleet-install.js').InstallOptions;

describe('fleet install and the pairing code', () => {
  it('hands installNode a minter rather than a code, so nothing is minted before the gates', async () => {
    mocks.installNode.mockImplementation(async (node: { name: string }) => ({
      node: node.name,
      ok: false,
      steps: [{ name: 'preflight', ok: false, detail: 'blocked' }],
    }));
    await runFleetCommand(['install', '--execute']);
    const opts = mocks.installNode.mock.calls[0][1] as InstallOpts;
    expect(opts.pairingCode).toBeUndefined();
    expect(typeof opts.mintPairingCode).toBe('function');
    expect(mocks.mintPairingCode).not.toHaveBeenCalled();
    expect(existsSync(storePath())).toBe(false);
  });

  it('keeps a minted code when the install fails after minting, and reuses it on the retry', async () => {
    // Attempt 1: mint, then fail at hub up.
    mocks.installNode.mockImplementationOnce(async (node: { name: string }, opts: InstallOpts) => {
      const minted = await opts.mintPairingCode?.();
      expect(minted?.code).toBe('ABC123');
      return { node: node.name, ok: false, steps: [{ name: 'hub up + register', ok: false, detail: 'hub-up-failed' }] };
    });
    await runFleetCommand(['install', '--execute']);
    expect(mocks.mintPairingCode).toHaveBeenCalledTimes(1);
    const kept = JSON.parse(readFileSync(storePath(), 'utf8'));
    expect(kept['10.0.0.7']).toMatchObject({ name: 'core-7', pairingCode: 'ABC123', orgId: 'org-1', deviceId: 'dev-1' });

    // Attempt 2: the same code comes back without a second mint, and is forgotten once registered.
    mocks.installNode.mockImplementationOnce(async (node: { name: string }, opts: InstallOpts) => {
      const minted = await opts.mintPairingCode?.();
      expect(minted?.code).toBe('ABC123');
      expect(minted?.detail).toMatch(/reusing/);
      opts.onRegistered?.();
      return { node: node.name, ok: true, steps: [] };
    });
    await runFleetCommand(['install', '--execute']);
    expect(mocks.mintPairingCode).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(storePath(), 'utf8'))).toEqual({});
  });

  it('turns a 409 into the two things it can mean', async () => {
    mocks.mintPairingCode.mockRejectedValue(new Error('a device named "core-7" already exists in this org'));
    let seen = '';
    mocks.installNode.mockImplementationOnce(async (node: { name: string }, opts: InstallOpts) => {
      await opts.mintPairingCode?.().catch((error: Error) => {
        seen = error.message;
      });
      return { node: node.name, ok: false, steps: [] };
    });
    await runFleetCommand(['install', '--execute']);
    expect(seen).toMatch(/earlier attempt/);
    expect(seen).toMatch(/another org/);
  });

  it('a stored code from a different org is not reused', async () => {
    const { savePendingPairingCode } = await import('../lib/fleet-pairing-codes.js');
    savePendingPairingCode({
      ip: '10.0.0.7',
      name: 'core-7',
      slug: 'core-7',
      deviceId: 'old',
      pairingCode: 'OLD999',
      orgId: 'some-other-org',
      mintedAt: '2026-09-01T00:00:00Z',
    });
    mocks.installNode.mockImplementationOnce(async (node: { name: string }, opts: InstallOpts) => {
      const minted = await opts.mintPairingCode?.();
      expect(minted?.code).toBe('ABC123');
      return { node: node.name, ok: true, steps: [] };
    });
    await runFleetCommand(['install', '--execute']);
    expect(mocks.mintPairingCode).toHaveBeenCalledTimes(1);
  });
});
