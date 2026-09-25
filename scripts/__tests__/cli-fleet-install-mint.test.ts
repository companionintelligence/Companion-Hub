/**
 * `cihub fleet install` and the Portal pairing code: minted last, kept until spent, reused on retry.
 *
 * The first fleet run minted first. Its first node then failed to download the binary, and the
 * retry got `409 a device named "beta-red" already exists` — the code was gone and the name was
 * taken. Nothing the CLI could do; a person had to delete the orphan in Portal. These tests pin the
 * three behaviours that make a retry possible — and the one that makes a kept code unusable: a
 * `fleet devices re-register`, which Portal answers with a newer code and honours alone.
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
// A GitHub token in the environment would make the run look the release up; none of this needs one.
const savedTokens = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
const storePath = () => join(configHome, 'cihub', 'fleet-pending-pairing-codes.json');
const readStore = () => JSON.parse(readFileSync(storePath(), 'utf8')) as { codes: Record<string, unknown>; reRegistered: Record<string, unknown> };

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
  mocks.mintPairingCode.mockReset().mockResolvedValue({ pairingCode: 'ABC123', deviceId: 'dev-1', slug: 'core-7', name: 'core-7' });
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

type InstallOpts = import('../lib/fleet-install.js').InstallOptions;

describe('fleet install and the pairing code', () => {
  it('hands installNode a minter rather than a code, so nothing is minted before the gates', async () => {
    mocks.installNode.mockImplementation(async (node: { name: string }) => ({
      node: node.name,
      ok: false,
      steps: [{ name: 'preflight', ok: false, detail: 'blocked' }],
    }));
    await runFleetCommand(['install', '--execute']);
    const opts = mocks.installNode.mock.calls[0]?.[1] as InstallOpts;
    expect(opts.pairingCode).toBeUndefined();
    expect(typeof opts.mintPairingCode).toBe('function');
    expect(mocks.mintPairingCode).not.toHaveBeenCalled();
    expect(existsSync(storePath())).toBe(false);
  });

  it('takes the Portal login from the environment, and hands installNode the Portal it mints on', async () => {
    // What makes a run unattended: a device:manage token in the environment, no `cihub login`.
    const env = {
      CI_PORTAL_TOKEN: 'cio_env',
      CI_PORTAL_ORG: 'org-env',
      CI_PORTAL_SCOPE: 'device:manage',
      CI_PORTAL_ORIGIN: 'https://hub.ci.computer',
    };
    Object.assign(process.env, env);
    try {
      mocks.installNode.mockImplementationOnce(async (node: { name: string }, opts: InstallOpts) => {
        await opts.mintPairingCode?.();
        return { node: node.name, ok: false, steps: [{ name: 'hub up + register', ok: false, detail: 'hub-up-failed' }] };
      });
      await runFleetCommand(['install', '--execute']);
      expect(mocks.mintPairingCode.mock.calls[0]?.[0]?.login).toMatchObject({
        token: 'cio_env',
        orgId: 'org-env',
        portalOrigin: 'https://hub.ci.computer',
      });
      expect((mocks.installNode.mock.calls[0]?.[1] as InstallOpts).portalOrigin).toBe('https://hub.ci.computer');
    } finally {
      for (const name of Object.keys(env)) delete process.env[name];
    }
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
    expect(readStore().codes['10.0.0.7']).toMatchObject({ name: 'core-7', pairingCode: 'ABC123', orgId: 'org-1', deviceId: 'dev-1' });

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
    expect(readStore().codes).toEqual({});
  });

  it('forgets a kept code the moment Portal declares it dead, so the next attempt mints fresh', async () => {
    // What beta-max looked like on 2026-09-22: three independently-minted codes, two domains, all
    // rejected 410 PAIRING_CODE_INVALID — including one used within seconds of being minted. With no
    // `fleet devices re-register` involved, nothing before this fix ever forgot the code.
    mocks.installNode.mockImplementationOnce(async (node: { name: string }, opts: InstallOpts) => {
      const minted = await opts.mintPairingCode?.();
      expect(minted?.code).toBe('ABC123');
      return {
        node: node.name,
        ok: false,
        steps: [{ name: 'hub up + register', ok: false, detail: 'That pairing code is no longer valid. Ask for a new one.' }],
      };
    });
    await runFleetCommand(['install', '--execute']);
    expect(mocks.mintPairingCode).toHaveBeenCalledTimes(1);
    expect(readStore().codes).toEqual({});

    // The retry mints again rather than resending the code Portal already refused.
    mocks.mintPairingCode.mockResolvedValueOnce({ pairingCode: 'FRESH01', deviceId: 'dev-1', slug: 'core-7', name: 'core-7' });
    mocks.installNode.mockImplementationOnce(async (node: { name: string }, opts: InstallOpts) => {
      const minted = await opts.mintPairingCode?.();
      expect(minted?.code).toBe('FRESH01');
      opts.onRegistered?.();
      return { node: node.name, ok: true, steps: [] };
    });
    await runFleetCommand(['install', '--execute']);
    expect(mocks.mintPairingCode).toHaveBeenCalledTimes(2);
  });

  it('keeps the kept code through a slow-tunnel timeout, since the same code may yet succeed (#1580)', async () => {
    mocks.installNode.mockImplementationOnce(async (node: { name: string }, opts: InstallOpts) => {
      await opts.mintPairingCode?.();
      return {
        node: node.name,
        ok: false,
        steps: [{ name: 'hub up + register', ok: false, detail: 'CI Portal did not respond in time. It may have partly completed.' }],
      };
    });
    await runFleetCommand(['install', '--execute']);
    expect(readStore().codes['10.0.0.7']).toMatchObject({ pairingCode: 'ABC123' });

    mocks.installNode.mockImplementationOnce(async (node: { name: string }, opts: InstallOpts) => {
      const minted = await opts.mintPairingCode?.();
      expect(minted?.code).toBe('ABC123');
      expect(minted?.detail).toMatch(/reusing/);
      opts.onRegistered?.();
      return { node: node.name, ok: true, steps: [] };
    });
    await runFleetCommand(['install', '--execute']);
    expect(mocks.mintPairingCode).toHaveBeenCalledTimes(1);
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

  it('still reads the first store format, a bare map keyed by address', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(configHome, 'cihub'), { recursive: true });
    const legacy = {
      ip: '10.0.0.7',
      name: 'core-7',
      slug: 'core-7',
      deviceId: 'dev-0',
      pairingCode: 'LEGACY1',
      orgId: 'org-1',
      mintedAt: '2026-09-18T00:00:00Z',
    };
    writeFileSync(storePath(), JSON.stringify({ '10.0.0.7': legacy }));
    mocks.installNode.mockImplementationOnce(async (node: { name: string }, opts: InstallOpts) => {
      const minted = await opts.mintPairingCode?.();
      expect(minted?.code).toBe('LEGACY1');
      return { node: node.name, ok: false, steps: [] };
    });
    await runFleetCommand(['install', '--execute']);
    expect(mocks.mintPairingCode).not.toHaveBeenCalled();
  });

  describe('after a fleet devices re-register', () => {
    const rosterNode = { name: 'core-7', ip: '10.0.0.7' };

    it('reuses the code re-register kept for the node, not the one install had kept', async () => {
      const { recordReRegisteredPairingCode, savePendingPairingCode } = await import('../lib/fleet-pairing-codes.js');
      // What core-1 looked like on 2026-09-20: install kept a code the day before, then re-register
      // minted a newer one through Portal, which killed the kept one.
      savePendingPairingCode({
        ip: '10.0.0.7',
        name: 'core-7',
        slug: 'core-7',
        deviceId: 'inactive-7',
        pairingCode: 'STALE00',
        orgId: 'org-1',
        mintedAt: '2026-09-19T17:19:00Z',
      });
      const kept = recordReRegisteredPairingCode({
        device: { id: 'inactive-7', name: 'core-7', slug: 'core-7' },
        deviceId: 'inactive-7',
        pairingCode: 'CGXKUR',
        orgId: 'org-1',
        roster: [rosterNode],
        at: '2026-09-20T18:02:00Z',
      });
      expect(kept).toMatchObject({ ip: '10.0.0.7', node: 'core-7', replaced: expect.objectContaining({ pairingCode: 'STALE00' }) });

      mocks.installNode.mockImplementationOnce(async (node: { name: string }, opts: InstallOpts) => {
        const minted = await opts.mintPairingCode?.();
        expect(minted?.code).toBe('CGXKUR');
        expect(minted?.detail).toMatch(/reusing the code re-registered 2026-09-20T18:02 for core-7/);
        opts.onRegistered?.();
        return { node: node.name, ok: true, steps: [] };
      });
      await runFleetCommand(['install', '--execute']);
      expect(mocks.mintPairingCode).not.toHaveBeenCalled();
      expect(readStore().codes).toEqual({});
    });

    it('refuses, naming the re-register, a kept code older than one the roster could not place', async () => {
      const { recordReRegisteredPairingCode, savePendingPairingCode } = await import('../lib/fleet-pairing-codes.js');
      // The re-register ran when the roster had no such node, so it could replace nothing; the
      // stale code then reappears (a roster row added later, a restored file). It must not be sent.
      recordReRegisteredPairingCode({
        device: { id: 'inactive-7', name: 'core-7', slug: 'core-7' },
        deviceId: 'inactive-7',
        pairingCode: 'CGXKUR',
        orgId: 'org-1',
        roster: [],
        at: '2026-09-20T18:02:00Z',
      });
      savePendingPairingCode({
        ip: '10.0.0.7',
        name: 'core-7',
        slug: 'core-7',
        deviceId: 'inactive-7',
        pairingCode: 'STALE00',
        orgId: 'org-1',
        mintedAt: '2026-09-19T17:19:00Z',
      });

      let seen = '';
      mocks.installNode.mockImplementationOnce(async (node: { name: string }, opts: InstallOpts) => {
        await opts.mintPairingCode?.().catch((error: Error) => {
          seen = error.message;
        });
        return { node: node.name, ok: false, steps: [] };
      });
      await runFleetCommand(['install', '--execute']);
      expect(seen).toMatch(/kept for core-7 was minted 2026-09-19T17:19/);
      expect(seen).toMatch(/re-register' at 2026-09-20T18:02 replaced it/);
      expect(seen).toMatch(/--code/);
      expect(mocks.mintPairingCode).not.toHaveBeenCalled();
    });

    it('explains a 409 by the re-register when nothing was kept for the node', async () => {
      const { recordReRegisteredPairingCode } = await import('../lib/fleet-pairing-codes.js');
      recordReRegisteredPairingCode({
        device: { id: 'inactive-7', name: 'core-7', slug: 'core-7' },
        deviceId: 'inactive-7',
        pairingCode: 'CGXKUR',
        orgId: 'org-1',
        roster: [],
        at: '2026-09-20T18:02:00Z',
      });
      mocks.mintPairingCode.mockRejectedValue(new Error('a device named "core-7" already exists in this org'));
      let seen = '';
      mocks.installNode.mockImplementationOnce(async (node: { name: string }, opts: InstallOpts) => {
        await opts.mintPairingCode?.().catch((error: Error) => {
          seen = error.message;
        });
        return { node: node.name, ok: false, steps: [] };
      });
      await runFleetCommand(['install', '--execute']);
      expect(seen).toMatch(/re-register' minted it a replacement code at 2026-09-20T18:02/);
      expect(seen).toMatch(/--code/);
      expect(seen).not.toMatch(/delete it in Portal/);
    });
  });
});
