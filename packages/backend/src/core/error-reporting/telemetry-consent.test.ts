import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONSENT_CACHE_TTL_MS,
  currentUserConsent,
  envTelemetryBlock,
  isLocalOnly,
  isReportingAllowed,
  isTelemetryOptedOut,
  readUserConsentFrom,
  resetUserConsentCache,
  resolveConsentDecision,
  resolveTelemetryDecision,
  setUserConsent,
  settingsFilePath,
} from './telemetry-consent';

const DSN = 'https://public@o1.ingest.sentry.io/2';

// The suite runs against the in-memory fs (see src/tests/vite.setup.ts), whose
// per-test reset recreates DATA_DIR/state — so this exercises the real
// settings-file path rather than a temp dir the mock does not model.
const settingsPath = settingsFilePath();

/** Put settings.json into a given state; `null` removes it entirely. */
function writeSettings(contents: string | null): string {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  if (contents === null) {
    if (fs.existsSync(settingsPath)) {
      fs.rmSync(settingsPath);
    }
  } else {
    fs.writeFileSync(settingsPath, contents);
  }

  return settingsPath;
}

beforeEach(() => {
  resetUserConsentCache();
});

afterEach(() => {
  resetUserConsentCache();
});

describe('env kill switches', () => {
  it.each(['off', 'false', '0', 'no', 'disabled', 'OFF', ' Off '])('treats CI_TELEMETRY=%s as opted out', (value) => {
    expect(isTelemetryOptedOut({ CI_TELEMETRY: value })).toBe(true);
  });

  it.each(['on', 'true', '1', '', undefined])('leaves the DSN in charge for CI_TELEMETRY=%s', (value) => {
    expect(isTelemetryOptedOut({ CI_TELEMETRY: value })).toBe(false);
  });

  it.each(['true', '1', 'yes', 'on', 'enabled', 'TRUE'])('treats CI_LOCAL_ONLY=%s as local-only', (value) => {
    expect(isLocalOnly({ CI_LOCAL_ONLY: value })).toBe(true);
  });

  it.each(['false', '0', 'no', '', undefined])('does not treat CI_LOCAL_ONLY=%s as local-only', (value) => {
    expect(isLocalOnly({ CI_LOCAL_ONLY: value })).toBe(false);
  });

  it('reports local-only ahead of an explicit opt-out', () => {
    expect(envTelemetryBlock({ CI_LOCAL_ONLY: 'true', CI_TELEMETRY: 'off' })).toBe('local-only');
    expect(envTelemetryBlock({ CI_TELEMETRY: 'off' })).toBe('opt-out');
    expect(envTelemetryBlock({})).toBeNull();
  });
});

describe('readUserConsentFrom', () => {
  it('reads the switch from settings.json', () => {
    expect(readUserConsentFrom(writeSettings('{"allowErrorMonitoring": true}'))).toBe(true);
    expect(readUserConsentFrom(writeSettings('{"allowErrorMonitoring": false}'))).toBe(false);
  });

  it('treats a missing file as "no preference yet", not a failed read', () => {
    // A fresh appliance has no settings.json. Failing closed here would mean
    // opt-out-by-default, which is not the shipped posture.
    expect(readUserConsentFrom(writeSettings(null))).toBe('unset');
  });

  it('treats an absent key as "no preference yet"', () => {
    expect(readUserConsentFrom(writeSettings('{"themeColor": "blue"}'))).toBe('unset');
    expect(readUserConsentFrom(writeSettings('{"allowErrorMonitoring": null}'))).toBe('unset');
  });

  it.each([
    ['unparseable JSON', '{ not json'],
    ['a JSON array', '[]'],
    ['a JSON scalar', '"nope"'],
    ['a stringly-typed value', '{"allowErrorMonitoring": "yes"}'],
    ['a numeric value', '{"allowErrorMonitoring": 1}'],
  ])('fails closed on %s', (_label, contents) => {
    expect(readUserConsentFrom(writeSettings(contents))).toBe('unreadable');
  });

  it('fails closed when the path exists but cannot be read as a file', () => {
    // Stands in for the real-world unreadable cases (EACCES after a UID change
    // on bind-mounted Hub data, EIO): any read error that is not ENOENT.
    writeSettings(null);
    fs.mkdirSync(settingsPath, { recursive: true });

    expect(readUserConsentFrom(settingsPath)).toBe('unreadable');
  });
});

describe('currentUserConsent caching', () => {
  it('memoises the disk read for the cache TTL, then re-reads', () => {
    writeSettings('{"allowErrorMonitoring": true}');
    const start = 1_000_000;

    expect(currentUserConsent(start, settingsPath)).toBe(true);

    writeSettings('{"allowErrorMonitoring": false}');

    // Still inside the TTL — the memoised answer stands.
    expect(currentUserConsent(start + CONSENT_CACHE_TTL_MS - 1, settingsPath)).toBe(true);
    // Past it, the change is picked up without any explicit invalidation.
    expect(currentUserConsent(start + CONSENT_CACHE_TTL_MS, settingsPath)).toBe(false);
  });

  it('publishes a written value immediately, without waiting for the TTL', () => {
    writeSettings('{"allowErrorMonitoring": true}');
    const start = 2_000_000;

    expect(currentUserConsent(start, settingsPath)).toBe(true);

    // This is what ConfigurationService.setUserSettings does on a flip.
    setUserConsent(false, start);

    expect(currentUserConsent(start, settingsPath)).toBe(false);
  });
});

describe('resolveConsentDecision', () => {
  it('permits reporting when nothing objects', () => {
    expect(resolveConsentDecision({ env: {}, consent: true })).toEqual({ enabled: true, reason: null });
    expect(resolveConsentDecision({ env: {}, consent: 'unset' })).toEqual({ enabled: true, reason: null });
  });

  it('applies the documented precedence: local-only > env opt-out > user setting', () => {
    expect(resolveConsentDecision({ env: { CI_LOCAL_ONLY: 'true', CI_TELEMETRY: 'on' }, consent: true })).toEqual({
      enabled: false,
      reason: 'local-only',
    });
    expect(resolveConsentDecision({ env: { CI_TELEMETRY: 'off' }, consent: true })).toEqual({
      enabled: false,
      reason: 'opt-out',
    });
    expect(resolveConsentDecision({ env: {}, consent: false })).toEqual({ enabled: false, reason: 'user-disabled' });
    expect(resolveConsentDecision({ env: {}, consent: 'unreadable' })).toEqual({
      enabled: false,
      reason: 'settings-unreadable',
    });
  });

  it('never reports no-dsn — clients carry their own DSN', () => {
    expect(resolveConsentDecision({ env: {}, consent: true }).reason).not.toBe('no-dsn');
  });
});

describe('resolveTelemetryDecision', () => {
  it('requires a DSN, but only once consent is settled', () => {
    expect(resolveTelemetryDecision({ env: {}, consent: true, dsn: DSN })).toEqual({ enabled: true, reason: null });
    expect(resolveTelemetryDecision({ env: {}, consent: true, dsn: '  ' })).toEqual({ enabled: false, reason: 'no-dsn' });
    expect(resolveTelemetryDecision({ env: {}, consent: true })).toEqual({ enabled: false, reason: 'no-dsn' });
    // A user opt-out is reported ahead of a missing DSN.
    expect(resolveTelemetryDecision({ env: {}, consent: false })).toEqual({ enabled: false, reason: 'user-disabled' });
  });
});

describe('isReportingAllowed', () => {
  it('is the beforeSend gate: it reflects a flip with no restart', () => {
    writeSettings('{"allowErrorMonitoring": true}');
    const now = 3_000_000;

    setUserConsent(currentUserConsent(now, settingsPath), now);
    expect(isReportingAllowed({})).toBe(true);

    setUserConsent(false, Date.now());
    expect(isReportingAllowed({})).toBe(false);

    setUserConsent(true, Date.now());
    expect(isReportingAllowed({})).toBe(true);
  });

  it('stays closed while an env kill switch is set, whatever the user chose', () => {
    setUserConsent(true, Date.now());

    expect(isReportingAllowed({ CI_LOCAL_ONLY: 'true' })).toBe(false);
    expect(isReportingAllowed({ CI_TELEMETRY: 'off' })).toBe(false);
  });
});
