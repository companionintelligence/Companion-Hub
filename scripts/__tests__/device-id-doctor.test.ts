import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../lib/cli-ui.js';
import { runDeviceIdDoctorSection } from '../lib/device-id-doctor.js';

/** Placeholders for what beta-red showed on 2026-09-17: its own machine ID, and the DEVICE_ID its env file shared with beta-nas. */
const BETA_RED_MACHINE_ID = '5eed5eed5eed5eed5eed5eed5eed5eed';
const COPIED_DEVICE_ID = 'c0ffee00c0ffee00c0ffee00c0ffee00';

const dir = mkdtempSync(join(tmpdir(), 'cihub-device-id-'));

function envFile(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

const betaRedHost = (path: string) => (path === '/etc/machine-id' ? `${BETA_RED_MACHINE_ID}\n` : null);

describe('cihub doctor device ID line', () => {
  it('fails on beta-red’s copied DEVICE_ID and prints the fix', () => {
    const file = envFile('copied.env', `API_PORT=5002\nDEVICE_ID=${COPIED_DEVICE_ID}\n`);

    const section = runDeviceIdDoctorSection(file, betaRedHost);
    const text = stripAnsi(section.lines.join('\n'));

    expect(section.failureCount).toBe(1);
    expect(text).toContain('copied from another machine');
    expect(text).toContain(`DEVICE_ID=${COPIED_DEVICE_ID}`);
    expect(text).toContain('cat /etc/machine-id');
    expect(text).toContain('register --code <code>');
    // The operator reads the host's machine ID from their own shell, never from this output.
    expect(text).not.toContain(BETA_RED_MACHINE_ID);
  });

  it('passes once DEVICE_ID is set to this host’s machine ID', () => {
    const section = runDeviceIdDoctorSection(envFile('fixed.env', `DEVICE_ID=${BETA_RED_MACHINE_ID}\n`), betaRedHost);

    expect(section.failureCount).toBe(0);
    expect(stripAnsi(section.lines.join('\n'))).toContain("this machine's");
  });

  it('reads the override from the same env file, so a deliberate hardware move does not fail doctor', () => {
    const file = envFile('moved.env', `DEVICE_ID=${COPIED_DEVICE_ID}\nHUB_ALLOW_FOREIGN_DEVICE_ID=true\n`);

    const section = runDeviceIdDoctorSection(file, betaRedHost);

    expect(section.failureCount).toBe(0);
    expect(stripAnsi(section.lines.join('\n'))).toContain('from another machine, kept');
  });

  it('never fails a machine it cannot check, such as a Mac with no /etc/machine-id or a missing env file', () => {
    expect(runDeviceIdDoctorSection(envFile('mac.env', `DEVICE_ID=${COPIED_DEVICE_ID}\n`), () => null).failureCount).toBe(0);
    expect(runDeviceIdDoctorSection(join(dir, 'absent.env'), betaRedHost).failureCount).toBe(0);
  });
});
