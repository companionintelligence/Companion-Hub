import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Mirrors the device ID logic from packages/backend/src/modules/registration/registration.service.ts
 *
 * 1. Try `dmidecode -s system-serial-number` (requires root)
 * 2. Fall back to /sys/class/dmi/id/product_uuid (same source systeminformation uses)
 */
function getDeviceId(): string {
  // Primary: dmidecode system-serial-number (needs root, so invoke via sudo)
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

  // Fallback: read hardware UUID directly (same as systeminformation's si.uuid().hardware)
  try {
    return readFileSync('/sys/class/dmi/id/product_uuid', 'utf-8').trim();
  } catch {
    console.error('Could not read /sys/class/dmi/id/product_uuid');
  }

  // Last resort: /etc/machine-id
  try {
    return readFileSync('/etc/machine-id', 'utf-8').trim();
  } catch {
    throw new Error('Unable to determine device ID from any source');
  }
}

console.log(getDeviceId());
