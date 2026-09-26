/**
 * The pending pairing-code store, on its own: what a `fleet devices re-register` does to it, and
 * how `fleet install` tells a code that re-register has killed from one it may send.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assessKeptPairingCode,
  classifyPairingFailure,
  clearPendingPairingCode,
  describeDeviceNameConflict,
  describeInvalidatedPairingCode,
  describeKeptPairingCode,
  describePairingCodeAge,
  findInvalidatingReRegistration,
  findReRegistration,
  forgetReleasedDevice,
  isDeadPairingCodeFailure,
  MAX_PENDING_PAIRING_CODE_AGE_MS,
  type PendingPairingCode,
  pendingPairingCodeAgeMs,
  PORTAL_PAIRING_CODE_TTL_MS,
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

/**
 * The three answers a failed `register` can give about its code, read off the real output. The
 * fleet run on 2026-09-22 produced all three on the same fifteen nodes within an hour.
 */
describe('classifyPairingFailure', () => {
  it('calls a 410 a refusal: the code is dead, and the device row is still there to re-register', () => {
    expect(classifyPairingFailure('Pairing failed\n  That pairing code is no longer valid. Ask for a new one.')).toMatchObject({ kind: 'refused' });
    expect(classifyPairingFailure('Portal pairing request failed: status=410 body={"code":"PAIRING_CODE_INVALID"}')).toMatchObject({
      kind: 'refused',
    });
    // The wipe took the key that proves this machine owns the row; only an owner-led re-register
    // gets past it, and it comes with a code.
    expect(classifyPairingFailure('status=403 body={"code":"DEVICE_PROOF_REQUIRED"}')).toMatchObject({ kind: 'refused' });
  });

  it('calls everything past acceptance a claim, because Portal takes the code before it provisions', () => {
    // beta-max: three separately minted codes, three identical DNS errors. The code was gone each
    // time and never the reason, which is why a replacement is the wrong move here.
    expect(
      classifyPairingFailure('Pairing accepted\nProvisioning tunnel and DNS\nDNS provider error while creating record. Please retry.'),
    ).toMatchObject({ kind: 'claimed' });
    expect(classifyPairingFailure('Pairing failed\n  DNS provider error while creating record. Please retry.')).toMatchObject({ kind: 'claimed' });
    expect(classifyPairingFailure('CI Portal did not answer in time.')).toMatchObject({ kind: 'claimed' });
    expect(classifyPairingFailure('Portal returned incomplete registration data.')).toMatchObject({ kind: 'claimed' });
  });

  it('says nothing about a failure that never reached the code, so the kept code stays kept', () => {
    expect(classifyPairingFailure('Unable to reach CI Portal. Please check your network connection.')).toBeUndefined();
    expect(classifyPairingFailure('hub-up-failed: nothing answered http://127.0.0.1:5002/api/registration/phase after cihub up')).toBeUndefined();
    expect(classifyPairingFailure('Error response from daemon: no such image')).toBeUndefined();
    expect(classifyPairingFailure('')).toBeUndefined();
  });

  it('reads across the line breaks a captured step has already mangled', () => {
    const boxed = ['┌─ Pairing failed ─┐', '│  That pairing code is no', '│  longer valid. Ask for a new one.', '└──┘'].join('\n');
    expect(classifyPairingFailure(boxed.replace(/[│┌┐└┘─]/g, ' '))).toMatchObject({ kind: 'refused' });
  });
});

/**
 * The narrower question, kept from #1584 and now answered by the same classifier: "dead" is a
 * refusal alone, and a code Portal claimed is not dead by this name — it is spent, which
 * `classifyPairingFailure` says and the caller must act on just as firmly.
 */
describe('isDeadPairingCodeFailure', () => {
  it("recognises Portal's literal 410 response text, box-drawing and all", () => {
    expect(isDeadPairingCodeFailure('That pairing code is no longer valid. Ask for a new one.')).toBe(true);
    expect(isDeadPairingCodeFailure('Pairing failed | That pairing code is no longer valid. Ask for a new one.')).toBe(true);
  });

  it('recognises the error code alone, case-sensitively as Portal sends it', () => {
    expect(isDeadPairingCodeFailure('status=410 body={"code":"PAIRING_CODE_INVALID"}')).toBe(true);
  });

  it('does not flag a failure that may still succeed if the same code is resent', () => {
    expect(isDeadPairingCodeFailure('hub-up-failed')).toBe(false);
    expect(isDeadPairingCodeFailure('CI Portal did not respond in time. It may have partly completed.')).toBe(false);
    expect(isDeadPairingCodeFailure('ssh: connect to host 10.0.0.7 port 22: Operation timed out')).toBe(false);
    // The DNS provider error from #1582 Update 2 is not Portal refusing the code — Portal had taken
    // it. Not dead, then, but not keepable either: the retry that followed it got the 410. That is
    // the distinction `classifyPairingFailure` draws and this narrower question cannot.
    expect(isDeadPairingCodeFailure('DNS provider error while creating record. Please retry.')).toBe(false);
  });
});

describe('the age of a kept code', () => {
  const HOUR = 60 * 60_000;

  it('is read from mintedAt, and an unreadable mintedAt is infinitely old rather than young', () => {
    const now = Date.parse('2026-09-26T06:14:00Z');
    expect(pendingPairingCodeAgeMs({ mintedAt: '2026-09-23T03:14:00Z' }, now)).toBe(75 * HOUR);
    // A code whose age cannot be read cannot be shown to be young enough to send.
    expect(pendingPairingCodeAgeMs({ mintedAt: 'yesterday-ish' }, now)).toBe(Number.POSITIVE_INFINITY);
    // A clock that moved backwards is not a negative age.
    expect(pendingPairingCodeAgeMs({ mintedAt: '2026-09-26T07:00:00Z' }, now)).toBe(0);
  });

  it('reads at a glance, precise enough to tell minutes from hours from days', () => {
    expect(describePairingCodeAge(30_000)).toBe('under a minute');
    expect(describePairingCodeAge(14 * 60_000)).toBe('14m');
    expect(describePairingCodeAge(5 * HOUR)).toBe('5h');
    expect(describePairingCodeAge(5 * HOUR + 12 * 60_000)).toBe('5h 12m');
    expect(describePairingCodeAge(MAX_PENDING_PAIRING_CODE_AGE_MS)).toBe('1d');
    expect(describePairingCodeAge(75 * HOUR)).toBe('3d 3h');
    expect(describePairingCodeAge(Number.POSITIVE_INFINITY)).toBe('an unknown time');
  });

  it('is named, with its origin, on every line about a kept code', () => {
    expect(describeKeptPairingCode(kept({ mintedAt: '2026-09-23T03:14:00Z', slug: 'core-6' }), 75 * HOUR)).toBe(
      'the code minted 2026-09-23T03:14 for core-6 (3d 3h ago)',
    );
    expect(describeKeptPairingCode(kept({ reRegisteredAt: '2026-09-20T18:02:00Z', mintedAt: '2026-09-20T18:02:00Z' }), 14 * 60_000)).toBe(
      'the code re-registered 2026-09-20T18:02 for core-1 (14m ago)',
    );
  });

  it('bounds reuse well inside the seven days Portal gives a code', () => {
    // CI-Portal's PAIRING_CODE_TTL_MS is 7 days and flagged there as a guess to be shortened. A bound
    // at or past it would send codes Portal has already expired, after a twenty-minute `hub up`.
    expect(PORTAL_PAIRING_CODE_TTL_MS).toBe(7 * 24 * HOUR);
    expect(describePairingCodeAge(PORTAL_PAIRING_CODE_TTL_MS)).toBe('7d');
    expect(MAX_PENDING_PAIRING_CODE_AGE_MS).toBeLessThan(PORTAL_PAIRING_CODE_TTL_MS);
    expect(MAX_PENDING_PAIRING_CODE_AGE_MS).toBe(24 * HOUR);
  });
});

describe('assessKeptPairingCode', () => {
  const at = (iso: string) => ({ now: Date.parse(iso), file });

  it('has nothing to say about a node with no kept code, or one kept for another org', () => {
    expect(assessKeptPairingCode('10.0.0.1', 'org-1', at('2026-09-19T18:00:00Z'))).toEqual({ kind: 'none' });
    savePendingPairingCode(kept({ orgId: 'org-2' }), file);
    expect(assessKeptPairingCode('10.0.0.1', 'org-1', at('2026-09-19T18:00:00Z'))).toEqual({ kind: 'none' });
  });

  it('reuses a code inside the limit and reports its age', () => {
    savePendingPairingCode(kept(), file);
    expect(assessKeptPairingCode('10.0.0.1', 'org-1', at('2026-09-19T19:49:00Z'))).toMatchObject({
      kind: 'reuse',
      ageMs: 150 * 60_000,
      pending: { pairingCode: 'OLD111' },
    });
  });

  it('calls a code past the limit too old — core-6 on 2026-09-26, three days after its mint', () => {
    savePendingPairingCode(kept({ ip: '10.0.0.6', name: 'core-6', slug: 'core-6', mintedAt: '2026-09-23T03:14:00Z' }), file);
    expect(assessKeptPairingCode('10.0.0.6', 'org-1', at('2026-09-23T03:14:00Z')).kind).toBe('reuse');
    expect(assessKeptPairingCode('10.0.0.6', 'org-1', at('2026-09-24T03:14:00Z')).kind).toBe('reuse');
    expect(assessKeptPairingCode('10.0.0.6', 'org-1', at('2026-09-24T03:15:00Z')).kind).toBe('too-old');
    expect(assessKeptPairingCode('10.0.0.6', 'org-1', at('2026-09-26T06:14:00Z'))).toMatchObject({ kind: 'too-old', ageMs: 75 * 60 * 60_000 });
  });

  it('names a later re-register ahead of age, since that reason comes with the code to send instead', () => {
    // A re-register the roster could not place, then an older code reappearing — the shape
    // `findInvalidatingReRegistration` exists for. Six days on it is also too old; the re-register wins.
    reRegister({ roster: [] });
    savePendingPairingCode(kept(), file);
    expect(assessKeptPairingCode('10.0.0.1', 'org-1', at('2026-09-26T00:00:00Z'))).toMatchObject({
      kind: 'invalidated',
      reRegistered: { at: '2026-09-20T18:02:00.000Z' },
    });
  });

  it('changes nothing in the store', () => {
    savePendingPairingCode(kept(), file);
    const before = readFileSync(file, 'utf8');
    assessKeptPairingCode('10.0.0.1', 'org-1', at('2026-09-26T00:00:00Z'));
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('forgetReleasedDevice', () => {
  it("drops the released device's codes and re-register record, and nothing of any other device or org", () => {
    reRegister({ roster: [] });
    savePendingPairingCode(kept(), file);
    savePendingPairingCode(kept({ ip: '10.0.0.7', name: 'core-7', slug: 'core-7', deviceId: 'd7', pairingCode: 'KEEP77' }), file);
    savePendingPairingCode(kept({ ip: '10.0.0.9', orgId: 'org-2', pairingCode: 'OTHER9' }), file);

    const forgotten = forgetReleasedDevice(device, 'org-1', file);

    expect(forgotten.map((c) => c.pairingCode)).toEqual(['OLD111']);
    expect(Object.keys(store().codes).sort()).toEqual(['10.0.0.7', '10.0.0.9']);
    expect(store().reRegistered).toEqual({});
    // The fresh device minted after the release is not explained by a re-register of the old row.
    expect(findReRegistration('core-1', 'org-1', file)).toBeUndefined();
  });

  it('matches by slug when Portal renamed the device, and leaves the file alone when nothing matches', () => {
    savePendingPairingCode(kept({ name: 'Core 1', slug: 'core-1', deviceId: 'other-id' }), file);
    expect(forgetReleasedDevice({ id: 'd-new', name: 'core-1' }, 'org-1', file)).toHaveLength(1);
    expect(store().codes).toEqual({});
    expect(forgetReleasedDevice({ id: 'd-new', name: 'core-1' }, 'org-1', join(dir, 'never-written.json'))).toEqual([]);
  });
});
