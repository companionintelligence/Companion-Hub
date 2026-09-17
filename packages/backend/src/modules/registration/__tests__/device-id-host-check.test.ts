import { describe, expect, it } from 'vitest';
import { ALLOW_FOREIGN_DEVICE_ID_ENV, checkDeviceIdHostBinding, foreignDeviceIdMessage } from '../device-id-host-check';

/** Placeholders for what beta-red showed on 2026-09-17: its own machine ID, and the DEVICE_ID its env file shared with beta-nas. */
const BETA_RED_MACHINE_ID = '5eed5eed5eed5eed5eed5eed5eed5eed';
const COPIED_DEVICE_ID = 'c0ffee00c0ffee00c0ffee00c0ffee00';

/** A host whose readable files are exactly `files`. Everything else is unreadable, as a root-only DMI node is to the CLI. */
function host(files: Record<string, string>): (path: string) => string | null {
  return (path) => files[path] ?? null;
}

const betaRed = host({ '/etc/machine-id': `${BETA_RED_MACHINE_ID}\n` });

describe('checkDeviceIdHostBinding', () => {
  it('flags the DEVICE_ID beta-red and beta-nas shared, which is neither host’s machine ID', () => {
    const binding = checkDeviceIdHostBinding({ envDeviceId: COPIED_DEVICE_ID, readFile: betaRed });

    expect(binding).toEqual({ status: 'foreign', deviceId: COPIED_DEVICE_ID, message: foreignDeviceIdMessage(COPIED_DEVICE_ID) });
  });

  it('accepts the DEVICE_ID the Linux desktop writes, which is this host’s own machine ID', () => {
    expect(checkDeviceIdHostBinding({ envDeviceId: BETA_RED_MACHINE_ID, readFile: betaRed })).toEqual({
      status: 'matches_host',
      deviceId: BETA_RED_MACHINE_ID,
    });
  });

  it('matches regardless of case, and against the dbus copy of the machine ID', () => {
    const dbusOnly = host({ '/var/lib/dbus/machine-id': BETA_RED_MACHINE_ID });

    expect(checkDeviceIdHostBinding({ envDeviceId: BETA_RED_MACHINE_ID.toUpperCase(), readFile: dbusOnly }).status).toBe('matches_host');
  });

  it('never refuses a 32-digit DMI identity that merely looks like a machine ID', () => {
    // CI-OS prefers product_serial and product_uuid, so either can be a legitimate DEVICE_ID. A dashless
    // product UUID is still that UUID.
    const withDmi = host({
      '/etc/machine-id': BETA_RED_MACHINE_ID,
      '/sys/class/dmi/id/product_uuid': '4C4C4544-0042-3510-8052-B4C04F4D3232',
    });

    expect(checkDeviceIdHostBinding({ envDeviceId: '4c4c4544004235108052b4c04f4d3232', readFile: withDmi }).status).toBe('matches_host');
  });

  it.each([
    ['a macOS IOPlatformUUID', '8A1C3F0E-51D2-4B7A-9E0C-2F6D1B3A4C5E'],
    ['a DMI serial', 'PF3XK2L9'],
    ['the Hub’s own generated fallback', 'generated-2b7f0e6a-5f7c-4a44-9d3a-1c0b7e7d2f10'],
    ['a CI-OS hostname hash', '9f86d081884c7d65'],
    ['a staging ID from pull-dev.sh', 'staging-core-7-1757000000'],
  ])('does not judge %s, since no host file could confirm or refute it', (_label, deviceId) => {
    expect(checkDeviceIdHostBinding({ envDeviceId: deviceId, readFile: betaRed }).status).toBe('not_checkable');
  });

  it.each([
    ['Docker Desktop', '7.0.12-linuxkit'],
    ['a WSL 2 distro', '6.6.87.2-microsoft-standard-WSL2'],
  ])('does not refuse a Linux desktop Hub on %s, whose container reads the VM’s machine ID through the bind mount', (_label, kernel) => {
    // Measured on Docker Desktop: `-v /etc/machine-id:/etc/machine-id:ro` handed the container the VM's own
    // 32-digit ID. The desktop app writes the real host's machine ID as DEVICE_ID and rewrites `.env` on
    // every launch, dropping the override, so a refusal here would leave that Hub unable to register.
    const dockerVm = host({ '/etc/machine-id': `${BETA_RED_MACHINE_ID}\n`, '/proc/sys/kernel/osrelease': `${kernel}\n` });

    expect(checkDeviceIdHostBinding({ envDeviceId: COPIED_DEVICE_ID, readFile: dockerVm })).toMatchObject({
      status: 'not_checkable',
      reason: expect.stringContaining('Docker VM'),
    });
  });

  it('still refuses the copied ID on a native engine, which is what beta-red and beta-nas run', () => {
    const nativeEngine = host({ '/etc/machine-id': BETA_RED_MACHINE_ID, '/proc/sys/kernel/osrelease': '7.0.0-31-generic\n' });

    expect(checkDeviceIdHostBinding({ envDeviceId: COPIED_DEVICE_ID, readFile: nativeEngine }).status).toBe('foreign');
  });

  it('does not guess when the machine ID is unreadable, as in a container started without the bind mount', () => {
    expect(checkDeviceIdHostBinding({ envDeviceId: COPIED_DEVICE_ID, readFile: host({}) })).toMatchObject({ status: 'not_checkable' });
  });

  it('does not trust a machine-id file that holds no machine ID, such as systemd’s first-boot `uninitialized`', () => {
    expect(checkDeviceIdHostBinding({ envDeviceId: COPIED_DEVICE_ID, readFile: host({ '/etc/machine-id': 'uninitialized\n' }) }).status).toBe(
      'not_checkable',
    );
  });

  it('has nothing to compare when DEVICE_ID is unset or a placeholder', () => {
    expect(checkDeviceIdHostBinding({ envDeviceId: undefined, readFile: betaRed })).toEqual({ status: 'not_set' });
    expect(checkDeviceIdHostBinding({ envDeviceId: '  ', readFile: betaRed })).toEqual({ status: 'not_set' });
  });

  it(`honours ${ALLOW_FOREIGN_DEVICE_ID_ENV}=true for a Hub deliberately moved to new hardware`, () => {
    expect(checkDeviceIdHostBinding({ envDeviceId: COPIED_DEVICE_ID, allowForeign: 'TRUE', readFile: betaRed })).toEqual({
      status: 'allowed_foreign',
      deviceId: COPIED_DEVICE_ID,
    });
    expect(checkDeviceIdHostBinding({ envDeviceId: COPIED_DEVICE_ID, allowForeign: '1', readFile: betaRed }).status).toBe('foreign');
  });
});

describe('foreignDeviceIdMessage', () => {
  it('gives the operator the whole remedy, and never the host’s own machine ID', () => {
    const message = foreignDeviceIdMessage(COPIED_DEVICE_ID);

    expect(message).toContain('cat /etc/machine-id');
    expect(message).toContain('cihub register --code <code>');
    expect(message).toContain(`${ALLOW_FOREIGN_DEVICE_ID_ENV}=true`);
    expect(message).not.toContain(BETA_RED_MACHINE_ID);
  });

  it('does not send a Hub already registered under the ID to change it, which would break its Portal key', () => {
    // core-14 on 2026-09-17: registered, with a machine-ID-shaped DEVICE_ID that no other node carried.
    const message = foreignDeviceIdMessage(COPIED_DEVICE_ID);
    const changeIt = message.indexOf('cat /etc/machine-id');
    const keepIt = message.indexOf(`${ALLOW_FOREIGN_DEVICE_ID_ENV}=true`);

    expect(message.slice(0, changeIt)).toContain('not registered yet');
    expect(message.slice(changeIt, keepIt)).toContain('already registered under this ID');
  });
});
