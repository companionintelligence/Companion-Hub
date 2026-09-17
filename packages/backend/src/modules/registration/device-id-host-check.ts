import fs from 'node:fs';
import { normalizeDeviceIdCandidate } from './device-id.resolver';

/**
 * Detects a `DEVICE_ID` that was copied from another machine.
 *
 * On 2026-09-17 beta-red and beta-nas had the same machine-ID-shaped `DEVICE_ID` in their `.env.prod`.
 * Their `/etc/machine-id` values differ, and neither one is that value, so it came from a third
 * machine's env file. Portal knows a Hub only by its device ID. Two Hubs with one ID are
 * one device to Portal: whichever pairs second either takes over the first one's registration or is
 * refused on it. Nothing on either machine looked wrong.
 *
 * The check is narrow on purpose, because a false positive blocks a real operator from pairing.
 * A `DEVICE_ID` is judged only when it has the exact shape of a systemd machine ID: 32 hex digits and
 * no dashes. In practice only a machine ID has that shape. The Linux desktop writes `/etc/machine-id`
 * as `DEVICE_ID`, and CI-OS falls back to it. The other sources look different: macOS
 * `IOPlatformUUID` and Windows `MachineGuid` are dashed UUIDs, DMI serials are free-form, the Hub's
 * own fallback starts with `generated-`, and CI-OS's hostname hash is 16 digits. The value must then
 * match none of the identifiers this host can read, and the host's machine ID must be readable. The
 * DMI product UUID and serials count as matches, so a DMI serial that happens to have the machine-ID
 * shape is never refused.
 *
 * Inside the Hub container, `/etc/machine-id` is the host's file: every compose file bind-mounts it
 * read-only, and the Alpine image ships none of its own. Without the mount the file is missing, and
 * the check reports `not_checkable` rather than guessing.
 */

/** Set to `true` to keep a machine-ID-shaped `DEVICE_ID` from another machine, as a deliberate hardware move. */
export const ALLOW_FOREIGN_DEVICE_ID_ENV = 'HUB_ALLOW_FOREIGN_DEVICE_ID';

const MACHINE_ID_FILES = ['/etc/machine-id', '/var/lib/dbus/machine-id'] as const;
/** Readable only as root on most hosts. The Hub container runs as root. The host-side CLI usually cannot read these, and it does not need to. */
const DMI_ID_FILES = ['/sys/class/dmi/id/product_uuid', '/sys/class/dmi/id/product_serial', '/sys/class/dmi/id/board_serial'] as const;

const MACHINE_ID_SHAPE = /^[0-9a-f]{32}$/i;

export type DeviceIdHostBinding =
  /** No `DEVICE_ID` in the environment. The Hub derives one from this machine, so there is nothing to compare. */
  | { status: 'not_set' }
  | { status: 'not_checkable'; deviceId: string; reason: string }
  | { status: 'matches_host'; deviceId: string }
  /** Foreign, and the operator has said so with {@link ALLOW_FOREIGN_DEVICE_ID_ENV}. Reported, never refused. */
  | { status: 'allowed_foreign'; deviceId: string }
  | { status: 'foreign'; deviceId: string; message: string };

export interface DeviceIdHostCheckInput {
  envDeviceId: string | undefined;
  allowForeign?: string | undefined;
  /** Returns a file's contents, or `null` when it cannot be read. Injected so both the Hub and the host-side CLI can run this. */
  readFile?: (path: string) => string | null;
}

function readFileOrNull(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/** Case and dashes do not distinguish identifiers: a dashless product UUID is still that UUID. */
function comparable(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, '');
}

/** The operator remedy, stated once so the Hub's refusal, its log and `cihub doctor` cannot drift apart. */
export function foreignDeviceIdMessage(deviceId: string): string {
  return (
    `DEVICE_ID=${deviceId} was not generated on this machine: it is not this host's /etc/machine-id or DMI identity. ` +
    "An env file copied from another Hub carries that Hub's device ID, and Portal treats two Hubs with one device ID as one device, so pairing this Hub would take over the other Hub's registration or be refused. " +
    "Fix: in this Hub's env file set DEVICE_ID to the output of `cat /etc/machine-id`, recreate the Hub container, then pair this Hub again with `cihub register --code <code>`. " +
    `If this Hub was deliberately moved to new hardware and must keep its Portal device, set ${ALLOW_FOREIGN_DEVICE_ID_ENV}=true instead.`
  );
}

export function checkDeviceIdHostBinding(input: DeviceIdHostCheckInput): DeviceIdHostBinding {
  const deviceId = normalizeDeviceIdCandidate(input.envDeviceId);
  if (!deviceId) {
    return { status: 'not_set' };
  }
  if (!MACHINE_ID_SHAPE.test(deviceId)) {
    return { status: 'not_checkable', deviceId, reason: 'DEVICE_ID is not a machine ID, so no host file can confirm or refute it' };
  }

  const read = input.readFile ?? readFileOrNull;
  const machineIds = MACHINE_ID_FILES.map((path) => normalizeDeviceIdCandidate(read(path))).filter(
    (value): value is string => value !== null && MACHINE_ID_SHAPE.test(value),
  );
  if (machineIds.length === 0) {
    return { status: 'not_checkable', deviceId, reason: "this host's /etc/machine-id is not readable here" };
  }

  const dmiIds = DMI_ID_FILES.map((path) => normalizeDeviceIdCandidate(read(path))).filter((value): value is string => value !== null);
  const wanted = comparable(deviceId);
  if ([...machineIds, ...dmiIds].some((hostId) => comparable(hostId) === wanted)) {
    return { status: 'matches_host', deviceId };
  }

  if (input.allowForeign?.trim().toLowerCase() === 'true') {
    return { status: 'allowed_foreign', deviceId };
  }
  return { status: 'foreign', deviceId, message: foreignDeviceIdMessage(deviceId) };
}
