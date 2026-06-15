/**
 * Print the device ID for this machine. Mirrors the backend registration logic.
 * Requires sudo for dmidecode access.
 *
 * Usage:
 *   pnpm exec tsx scripts/get-device-id.ts
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Mirrors the device ID logic from packages/backend/src/modules/registration/registration.service.ts
 *
 * 1. Try `dmidecode -s system-serial-number` (requires root)
 * 2. Fall back to /sys/class/dmi/id/product_uuid (same source systeminformation uses)
 */
export function getDeviceId(): string {
  // macOS: ioreg IOPlatformUUID
  if (process.platform === 'darwin') {
    try {
      const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice', { timeout: 5000, encoding: 'utf-8' });
      const match = /IOPlatformUUID\s*=\s*"([^"]+)"/.exec(out);
      if (match?.[1]) return match[1];
    } catch {
      console.error('ioreg failed on macOS, trying serial number');
    }
    try {
      const serial = execSync('system_profiler SPHardwareDataType', { timeout: 5000, encoding: 'utf-8' });
      const match = /Serial Number.*?:\s*(\S+)/.exec(serial);
      if (match?.[1]) return match[1];
    } catch {
      console.error('system_profiler failed');
    }
  }

  // Linux primary: dmidecode system-serial-number (needs root)
  try {
    const serial = execSync('sudo dmidecode -s system-serial-number', {
      timeout: 5000,
      encoding: 'utf-8',
    }).trim();

    if (serial && serial !== 'Not Specified' && serial.toLowerCase() !== 'to be filled by o.e.m.' && serial !== 'Default string') {
      return serial;
    }

    console.error(`dmidecode returned unusable value: "${serial}", falling back to hardware UUID`);
  } catch {
    console.error('dmidecode failed, falling back to hardware UUID');
  }

  // Linux fallback: /sys/class/dmi/id/product_uuid
  try {
    return readFileSync('/sys/class/dmi/id/product_uuid', 'utf-8').trim();
  } catch {
    console.error('Could not read /sys/class/dmi/id/product_uuid');
  }

  // Last resort: /etc/machine-id (Linux)
  try {
    return readFileSync('/etc/machine-id', 'utf-8').trim();
  } catch {
    throw new Error('Unable to determine device ID from any source');
  }
}

const isDirectRun = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isDirectRun) {
  console.log(getDeviceId());
}
