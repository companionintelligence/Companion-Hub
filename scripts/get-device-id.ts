/**
 * Print the device ID for this machine. Mirrors the backend registration logic.
 * Requires sudo for dmidecode access.
 *
 * Usage:
 *   pnpm exec tsx scripts/get-device-id.ts
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isDirectScriptRun } from './lib/is-direct-run';

/**
 * Mirrors the device ID logic from packages/backend/src/modules/registration/registration.service.ts
 *
 * 1. Try `dmidecode -s system-serial-number` (requires root)
 * 2. Fall back to /sys/class/dmi/id/product_uuid (same source systeminformation uses)
 */
export function getDeviceId(): string {
  // Windows: wmic / registry MachineGuid
  if (process.platform === 'win32') {
    // Primary: WMI product UUID (same as dmidecode system-uuid on Linux)
    try {
      const out = execSync('wmic csproduct get uuid /value', {
        timeout: 5000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = /UUID\s*=\s*([0-9A-Fa-f-]{36})/.exec(out);
      if (match?.[1] && match[1].toUpperCase() !== 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF') {
        return match[1];
      }
    } catch {
      // wmic may be unavailable on some Windows 11 builds
    }
    // Fallback: registry MachineGuid (stable per-install identifier)
    try {
      const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', {
        timeout: 5000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out);
      if (match?.[1]) return match[1];
    } catch {
      // ignore
    }
    // Last resort: PowerShell Get-CimInstance
    try {
      const out = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_ComputerSystemProduct).UUID"', {
        timeout: 8000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (out && out.toUpperCase() !== 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF') {
        return out;
      }
    } catch {
      // ignore
    }
    // All hardware sources exhausted — emit a warning and continue with a
    // stable per-user fallback so `cihub up` is never blocked on Windows.
    console.warn('Warning: could not read a hardware device ID on Windows; using a local fallback identifier.');
    return `windows-fallback-${process.env.USERNAME ?? process.env.COMPUTERNAME ?? 'unknown'}`;
  }

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

const isDirectRun = isDirectScriptRun(import.meta.url, import.meta.main);

if (isDirectRun) {
  console.log(getDeviceId());
}
