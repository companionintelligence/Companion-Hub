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
  reRegisterPortalDevice: vi.fn(),
  scope: 'device:pair',
  nodes: [] as import('../lib/fleet-roster.js').FleetNode[],
}));

vi.mock('../lib/fleet-roster.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-roster.js')>()),
  loadFleetRoster: () => ({ nodes: mocks.nodes, source: 'test-roster', dropped: [] }),
}));

vi.mock('../lib/catalog-submit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/catalog-submit.js')>()),
  readStoredLogin: () => ({ orgSlug: 'bill-co', orgId: 'org-1', token: 't', portalOrigin: 'https://portal.test', scope: mocks.scope }),
  loginScope: () => mocks.scope,
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
const { stripAnsi } = await import('../lib/cli-ui.js');

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
  mocks.reRegisterPortalDevice.mockReset().mockResolvedValue({ pairingCode: 'FRESH7', deviceId: 'dev-1' });
  mocks.scope = 'device:pair';
  mocks.nodes = [{ name: 'core-7', ip: '10.0.0.7' }];
});

afterEach(() => {
  vi.useRealTimers();
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

/**
 * Pin the clock for a test whose kept codes carry real dates. Only `Date` is faked — the run's own
 * awaits must still resolve — and a kept code is reused for a day, so "now" has to sit near them.
 */
const clockAt = (iso: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
};

/** Run one install whose node asks for a code, and hand back what the minter answered or threw. */
async function installOnce(): Promise<{ code?: string; detail?: string; error?: string }> {
  const seen: { code?: string; detail?: string; error?: string } = {};
  mocks.installNode.mockImplementationOnce(async (node: { name: string }, opts: InstallOpts) => {
    try {
      Object.assign(seen, await opts.mintPairingCode?.());
    } catch (error) {
      seen.error = error instanceof Error ? error.message : String(error);
    }
    return { node: node.name, ok: false, steps: [] };
  });
  await runFleetCommand(['install', '--execute']);
  return seen;
}

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
    clockAt('2026-09-18T02:00:00Z');
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
      clockAt('2026-09-20T19:00:00Z');
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
        expect(minted?.detail).toBe('reusing the code re-registered 2026-09-20T18:02 for core-7 (58m ago)');
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

describe('a kept code and its age', () => {
  const keep = async (over: Partial<import('../lib/fleet-pairing-codes.js').PendingPairingCode> = {}) => {
    const { savePendingPairingCode } = await import('../lib/fleet-pairing-codes.js');
    savePendingPairingCode({
      ip: '10.0.0.7',
      name: 'core-7',
      slug: 'core-7',
      deviceId: 'dev-old',
      pairingCode: 'OLD777',
      orgId: 'org-1',
      mintedAt: '2026-09-23T03:14:00.000Z',
      ...over,
    });
  };

  it('says how old the code is whenever it reuses one', async () => {
    clockAt('2026-09-23T05:44:00Z');
    await keep();
    const seen = await installOnce();
    expect(seen.code).toBe('OLD777');
    expect(seen.detail).toBe('reusing the code minted 2026-09-23T03:14 for core-7 (2h 30m ago)');
    expect(mocks.mintPairingCode).not.toHaveBeenCalled();
  });

  it('replaces a code kept past a day with a fresh mint — core-6 on 2026-09-26, three days on', async () => {
    // What went out instead: "reusing the code minted 2026-09-23T03:14", with nothing to say when.
    clockAt('2026-09-26T06:14:00Z');
    await keep();
    const seen = await installOnce();
    expect(mocks.mintPairingCode).toHaveBeenCalledTimes(1);
    expect(seen.code).toBe('ABC123');
    expect(seen.detail).toBe(
      'replaced the code minted 2026-09-23T03:14 for core-7 (3d 3h ago), older than the 1d a kept code is reused for; registered as core-7',
    );
    // The fresh code is the one kept for a retry now, stamped with today.
    expect(readStore().codes['10.0.0.7']).toMatchObject({ pairingCode: 'ABC123', mintedAt: '2026-09-26T06:14:00.000Z' });
  });

  it('re-registers the old row for a fresh code when the mint 409s and the login can, and keeps it', async () => {
    // The row outlived its code, so a new POST /api/devices is refused by name. device:manage asks
    // Portal to reissue the code on that row instead — the same replacement a refused code gets.
    clockAt('2026-09-26T06:14:00Z');
    mocks.scope = 'device:manage';
    mocks.mintPairingCode.mockRejectedValue(new Error('a device named "core-7" already exists in this org'));
    await keep();
    const seen = await installOnce();
    expect(mocks.reRegisterPortalDevice).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'dev-old' }));
    expect(seen.code).toBe('FRESH7');
    expect(seen.detail).toMatch(/^replaced the code minted 2026-09-23T03:14 for core-7 \(3d 3h ago\).*; re-registered core-7 for a fresh one$/);
    expect(readStore().codes['10.0.0.7']).toMatchObject({ pairingCode: 'FRESH7', reRegisteredAt: '2026-09-26T06:14:00.000Z' });
  });

  it('keeps the old code when the replacement mint fails, so the next run still re-registers its row', async () => {
    // Dropping the code before the mint came back left nothing to re-register with: a Portal 503
    // here, then the certain 409 on the next run read as a bare name conflict, and a person had to
    // re-register or release the device by hand.
    clockAt('2026-09-26T06:14:00Z');
    mocks.scope = 'device:manage';
    mocks.mintPairingCode.mockRejectedValueOnce(new Error('HTTP 503 Service Unavailable'));
    await keep();
    const first = await installOnce();
    expect(first.code).toBeUndefined();
    expect(first.error).toBe(
      'the code minted 2026-09-23T03:14 for core-7 (3d 3h ago), older than the 1d a kept code is reused for: minting a replacement failed (HTTP 503 Service Unavailable). It is still kept, so the next run tries to replace it again.',
    );
    expect(readStore().codes['10.0.0.7']).toMatchObject({ pairingCode: 'OLD777', deviceId: 'dev-old' });

    // An hour on, Portal is back and the row the old code was minted with is still there.
    clockAt('2026-09-26T07:14:00Z');
    mocks.mintPairingCode.mockRejectedValueOnce(new Error('a device named "core-7" already exists in this org'));
    const second = await installOnce();
    expect(mocks.reRegisterPortalDevice).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'dev-old' }));
    expect(second.code).toBe('FRESH7');
    expect(readStore().codes['10.0.0.7']).toMatchObject({ pairingCode: 'FRESH7', reRegisteredAt: '2026-09-26T07:14:00.000Z' });
  });

  it('keeps the old code when the re-register fails, for the next run to try again', async () => {
    clockAt('2026-09-26T06:14:00Z');
    mocks.scope = 'device:manage';
    mocks.mintPairingCode.mockRejectedValue(new Error('a device named "core-7" already exists in this org'));
    mocks.reRegisterPortalDevice.mockRejectedValueOnce(new Error('HTTP 502 Bad Gateway'));
    await keep();
    const seen = await installOnce();
    expect(seen.code).toBeUndefined();
    expect(seen.error).toMatch(/^the code minted 2026-09-23T03:14 for core-7 \(3d 3h ago\)/);
    expect(seen.error).toContain('re-registering it for a fresh code failed (HTTP 502 Bad Gateway). It is still kept');
    expect(readStore().codes['10.0.0.7']).toMatchObject({ pairingCode: 'OLD777', deviceId: 'dev-old' });
  });

  it('keeps the re-registered code under the node even when the roster has renamed it', async () => {
    // The fresh code is filed under a roster node named for the device, or else where the old code
    // was kept. With the old code already gone there was neither, and the fresh one was kept for none.
    clockAt('2026-09-26T06:14:00Z');
    mocks.scope = 'device:manage';
    mocks.nodes = [{ name: 'core-seven', ip: '10.0.0.7' }];
    mocks.mintPairingCode.mockRejectedValue(new Error('a device named "core-seven" already exists in this org'));
    await keep();
    const seen = await installOnce();
    expect(seen.code).toBe('FRESH7');
    expect(readStore().codes['10.0.0.7']).toMatchObject({ pairingCode: 'FRESH7', deviceId: 'dev-1' });
  });

  it('under device:pair, sends a code Portal still honours when the mint 409s, saying how old it is, and keeps it', async () => {
    // This login cannot re-register, so there is no replacement to be had while the row exists — and
    // Portal honours the code for seven days. Dropping it here failed the node and lost a code that
    // would have paired.
    clockAt('2026-09-26T06:14:00Z');
    mocks.mintPairingCode.mockRejectedValue(new Error('a device named "core-7" already exists in this org'));
    await keep();
    const seen = await installOnce();
    expect(mocks.reRegisterPortalDevice).not.toHaveBeenCalled();
    expect(seen.error).toBeUndefined();
    expect(seen.code).toBe('OLD777');
    expect(seen.detail).toBe(
      `reusing the code minted 2026-09-23T03:14 for core-7 (3d 3h ago) anyway, past the 1d a kept code is normally reused for: a device named "core-7" still exists, Portal honours a code for 7d, and replacing it is a re-register, which needs 'cihub login --scope device:manage' (this run holds device:pair)`,
    );
    expect(readStore().codes['10.0.0.7']).toMatchObject({ pairingCode: 'OLD777' });
  });

  it("under device:pair, refuses a code past Portal's seven days but keeps it for a login that can re-register", async () => {
    clockAt('2026-10-01T06:14:00Z');
    mocks.mintPairingCode.mockRejectedValue(new Error('a device named "core-7" already exists in this org'));
    await keep();
    const seen = await installOnce();
    expect(mocks.reRegisterPortalDevice).not.toHaveBeenCalled();
    expect(seen.code).toBeUndefined();
    expect(seen.error).toMatch(/^the code minted 2026-09-23T03:14 for core-7 \(8d 3h ago\), .*past the 7d Portal honours a code for\./);
    expect(seen.error).toContain("cihub login --scope device:manage' (this run holds device:pair)");
    expect(seen.error).toContain('delete the device in Portal and rerun');
    expect(readStore().codes['10.0.0.7']).toMatchObject({ pairingCode: 'OLD777', deviceId: 'dev-old' });

    // The kept device id is what lets a device:manage run replace it without a person in Portal.
    mocks.scope = 'device:manage';
    const retry = await installOnce();
    expect(mocks.reRegisterPortalDevice).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'dev-old' }));
    expect(retry.code).toBe('FRESH7');
  });

  describe('in a dry run', () => {
    const dryRun = async () => {
      const log = vi.spyOn(console, 'log');
      await runFleetCommand(['install']);
      return stripAnsi(log.mock.calls.map((call) => String(call[0])).join('\n'));
    };

    beforeEach(async () => {
      clockAt('2026-09-26T06:14:00Z');
      mocks.nodes = [
        { name: 'core-5', ip: '10.0.0.5' },
        { name: 'core-6', ip: '10.0.0.6' },
        { name: 'core-7', ip: '10.0.0.7' },
        { name: 'core-8', ip: '10.0.0.8' },
      ];
      await keep({ ip: '10.0.0.6', name: 'core-6', slug: 'core-6' });
      await keep({ mintedAt: '2026-09-26T03:44:00.000Z' });
      await keep({ ip: '10.0.0.8', name: 'core-8', slug: 'core-8', mintedAt: '2026-09-18T03:14:00.000Z' });
    });

    it('shows, per node, what the run would do with each kept code', async () => {
      const out = await dryRun();
      expect(out).toContain('Would install on 4 of 4 rostered node(s):');
      expect(out).toMatch(/core-5\s+10\.0\.0\.5\s+mint new/);
      expect(out).toMatch(/core-7\s+10\.0\.0\.7\s+reuse, kept 2h 30m/);
      // device:pair cannot re-register, so an old code whose row still exists is reused inside
      // Portal's seven days and refused past them — and a dry run cannot know which rows still exist.
      expect(out).toMatch(/core-6\s+10\.0\.0\.6\s+replace or reuse, kept 3d 3h/);
      expect(out).toMatch(/core-8\s+10\.0\.0\.8\s+replace or refuse, kept 8d 3h/);
      expect(out).toContain(`"replace" mints a fresh code if the node's device is gone from Portal`);
      // A dry run reads the store and never writes it.
      expect(readStore().codes['10.0.0.6']).toMatchObject({ pairingCode: 'OLD777' });
      expect(mocks.installNode).not.toHaveBeenCalled();
      expect(mocks.mintPairingCode).not.toHaveBeenCalled();
    });

    it('says plainly "replace" when the login can re-register whatever row still exists', async () => {
      mocks.scope = 'device:manage';
      const out = await dryRun();
      expect(out).toMatch(/core-6\s+10\.0\.0\.6\s+replace, kept 3d 3h/);
      expect(out).toMatch(/core-8\s+10\.0\.0\.8\s+replace, kept 8d 3h/);
      expect(out).not.toContain('"replace" mints a fresh code');
    });
  });
});
