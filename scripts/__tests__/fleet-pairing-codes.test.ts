/**
 * The pending pairing-code store, on its own: what a `fleet devices re-register` does to it, and
 * how `fleet install` tells a code that re-register has killed from one it may send.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearPendingPairingCode,
  describeDeviceNameConflict,
  describeInvalidatedPairingCode,
  findInvalidatingReRegistration,
  findReRegistration,
  type PendingPairingCode,
  readPendingPairingCode,
  recordReRegisteredPairingCode,
  savePendingPairingCode,
} from '../lib/fleet-pairing-codes.js';

let dir: string;
let file: string;
const store = () => JSON.parse(readFileSync(file, 'utf8')) as { codes: Record<string, PendingPairingCode>; reRegistered: Record<string, unknown> };

const kept = (over: Partial<PendingPairingCode> = {}): PendingPairingCode => ({
  ip: '10.0.0.1',
  name: 'core-1',
  slug: 'core-1',
  deviceId: 'inactive-1',
  pairingCode: 'OLD111',
  orgId: 'org-1',
  mintedAt: '2026-09-19T17:19:00.000Z',
  ...over,
});

const device = { id: 'inactive-1', name: 'core-1', slug: 'core-1' };
const reRegister = (over: Partial<Parameters<typeof recordReRegisteredPairingCode>[0]> = {}) =>
  recordReRegisteredPairingCode(
    {
      device,
      deviceId: 'inactive-1',
      pairingCode: 'CGXKUR',
      orgId: 'org-1',
      roster: [{ name: 'core-1', ip: '10.0.0.1' }],
      at: '2026-09-20T18:02:00.000Z',
      ...over,
    },
    file,
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cihub-codes-'));
  file = join(dir, 'fleet-pending-pairing-codes.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('recordReRegisteredPairingCode', () => {
  it('replaces the code kept for the roster node the device is named after', () => {
    savePendingPairingCode(kept(), file);
    const result = reRegister();
    expect(result).toMatchObject({ ip: '10.0.0.1', node: 'core-1', replaced: expect.objectContaining({ pairingCode: 'OLD111' }) });
    expect(readPendingPairingCode('10.0.0.1', 'org-1', file)).toMatchObject({
      pairingCode: 'CGXKUR',
      mintedAt: '2026-09-20T18:02:00.000Z',
      reRegisteredAt: '2026-09-20T18:02:00.000Z',
    });
  });

  it('matches the roster by the Portal slug too, case-insensitively, and drops the stale code wherever it was kept', () => {
    // The roster row moved address since install kept the code; the new one goes under the roster's,
    // and the old address is not left holding a dead code for whatever node lands there next.
    savePendingPairingCode(kept({ ip: '10.0.0.9' }), file);
    const result = reRegister({ device: { id: 'inactive-1', name: 'Core 1', slug: 'core-1' }, roster: [{ name: 'CORE-1', ip: '10.0.0.1' }] });
    expect(result.ip).toBe('10.0.0.1');
    expect(result.replaced?.pairingCode).toBe('OLD111');
    expect(readPendingPairingCode('10.0.0.9', 'org-1', file)).toBeUndefined();
    expect(readPendingPairingCode('10.0.0.1', 'org-1', file)?.pairingCode).toBe('CGXKUR');
  });

  it("leaves other nodes' codes, and the same name in another org, alone", () => {
    savePendingPairingCode(kept({ ip: '10.0.0.2', name: 'core-2', slug: 'core-2', deviceId: 'inactive-2', pairingCode: 'TWO222' }), file);
    savePendingPairingCode(kept({ ip: '10.0.0.1', orgId: 'org-9', pairingCode: 'OTHER9' }), file);
    reRegister({ roster: [{ name: 'core-1', ip: '10.0.0.3' }] });
    expect(readPendingPairingCode('10.0.0.2', 'org-1', file)?.pairingCode).toBe('TWO222');
    expect(readPendingPairingCode('10.0.0.1', 'org-9', file)?.pairingCode).toBe('OTHER9');
    expect(readPendingPairingCode('10.0.0.3', 'org-1', file)?.pairingCode).toBe('CGXKUR');
  });

  it('falls back to where install had kept the code when the roster has no such node', () => {
    savePendingPairingCode(kept(), file);
    const result = reRegister({ roster: [] });
    expect(result).toMatchObject({ ip: '10.0.0.1', node: 'core-1' });
    expect(readPendingPairingCode('10.0.0.1', 'org-1', file)?.pairingCode).toBe('CGXKUR');
  });

  it('keeps nothing, and says why, with neither a roster node nor a kept code — but logs the re-register', () => {
    const result = reRegister({ roster: [] });
    expect(result.ip).toBeUndefined();
    expect(result.why).toBe('no roster node is named core-1, so the code was kept for none');
    expect(store().codes).toEqual({});
    expect(findReRegistration('core-1', 'org-1', file)).toMatchObject({ deviceId: 'inactive-1', at: '2026-09-20T18:02:00.000Z' });
  });

  it('will not guess between two roster rows of the same name unless one already held the code', () => {
    const twins = [
      { name: 'core-1', ip: '10.0.0.1' },
      { name: 'core-1', ip: '10.0.0.11' },
    ];
    const blind = reRegister({ roster: twins });
    expect(blind.ip).toBeUndefined();
    expect(blind.why).toMatch(/2 roster nodes are named core-1 \(10\.0\.0\.1, 10\.0\.0\.11\)/);

    savePendingPairingCode(kept({ ip: '10.0.0.11' }), file);
    expect(reRegister({ roster: twins }).ip).toBe('10.0.0.11');
  });
});

describe('findInvalidatingReRegistration', () => {
  it('names the re-register that outdates a kept code, by device, within the org', () => {
    reRegister({ roster: [] });
    const stale = kept();
    const invalidating = findInvalidatingReRegistration(stale, file);
    expect(invalidating?.at).toBe('2026-09-20T18:02:00.000Z');
    expect(findInvalidatingReRegistration(kept({ orgId: 'org-9' }), file)).toBeUndefined();
    expect(findInvalidatingReRegistration(kept({ name: 'core-2', slug: 'core-2', deviceId: 'inactive-2' }), file)).toBeUndefined();
    expect(describeInvalidatedPairingCode(stale, invalidating ?? { deviceId: '', name: '', orgId: '', at: '' })).toMatch(
      /kept for core-1 was minted 2026-09-19T17:19, but 'cihub fleet devices re-register' at 2026-09-20T18:02 replaced it/,
    );
  });

  it('never flags the code re-register itself kept, nor one minted after it', () => {
    reRegister();
    const own = readPendingPairingCode('10.0.0.1', 'org-1', file);
    expect(own?.pairingCode).toBe('CGXKUR');
    expect(findInvalidatingReRegistration(own ?? kept(), file)).toBeUndefined();
    expect(findInvalidatingReRegistration(kept({ mintedAt: '2026-09-21T00:00:00Z' }), file)).toBeUndefined();
  });

  it('compares instants, not strings — a second-precision timestamp is not older than its millisecond twin', () => {
    reRegister({ roster: [], at: '2026-09-20T18:02:00.000Z' });
    expect(findInvalidatingReRegistration(kept({ mintedAt: '2026-09-20T18:02:00Z' }), file)).toBeUndefined();
  });
});

describe('describeDeviceNameConflict', () => {
  it('replaces the two guesses with the known cause when this machine re-registered the device', () => {
    expect(describeDeviceNameConflict('core-1')).toMatch(/delete it in Portal/);
    reRegister({ roster: [] });
    const known = describeDeviceNameConflict('core-1', findReRegistration('core-1', 'org-1', file));
    expect(known).toMatch(/re-register' minted it a replacement code at 2026-09-20T18:02/);
    expect(known).not.toMatch(/delete it in Portal/);
  });
});

describe('the store file', () => {
  it('reads the first format — the codes map alone — and rewrites it in the current one, keeping the codes', () => {
    writeFileSync(file, JSON.stringify({ '10.0.0.1': kept() }));
    expect(readPendingPairingCode('10.0.0.1', 'org-1', file)?.pairingCode).toBe('OLD111');
    savePendingPairingCode(kept({ ip: '10.0.0.2', name: 'core-2' }), file);
    expect(Object.keys(store().codes).sort()).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(store().reRegistered).toEqual({});
  });

  it('clearing a spent code leaves the re-register log in place', () => {
    reRegister();
    clearPendingPairingCode('10.0.0.1', file);
    expect(store().codes).toEqual({});
    expect(findReRegistration('core-1', 'org-1', file)).toBeDefined();
  });
});
