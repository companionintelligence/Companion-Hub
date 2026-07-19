import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import si from 'systeminformation';

export const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const INVALID_DEVICE_ID_VALUES = new Set([
  'not specified',
  'to be filled by o.e.m.',
  'default string',
  'system serial number',
  'chassis serial number',
  'none',
  'na',
  'n/a',
  '0',
  '',
]);

export function normalizeDeviceIdCandidate(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (INVALID_DEVICE_ID_VALUES.has(trimmed.toLowerCase())) return null;
  if (trimmed.toLowerCase() === ZERO_UUID) return null;
  return trimmed;
}

type DeviceIdLogger = {
  debug: (message: string, error?: unknown) => void;
  warn: (message: string) => void;
};

export type ResolveDeviceIdOptions = {
  envDeviceId?: string;
  dataDir: string;
  logger?: DeviceIdLogger;
  execCommand?: typeof execSync;
  readUuid?: () => Promise<{ hardware?: string; os?: string }>;
};

function readFileDeviceId(filePath: string, logger?: DeviceIdLogger): string | null {
  try {
    return normalizeDeviceIdCandidate(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    logger?.debug(`Could not read ${filePath}`, error);
    return null;
  }
}

function readDarwinHostDeviceId(execCommand: typeof execSync, logger?: DeviceIdLogger): string | null {
  try {
    const output = execCommand('ioreg -rd1 -c IOPlatformExpertDevice', {
      timeout: 5000,
      encoding: 'utf-8',
    });
    const match = /IOPlatformUUID\s*=\s*"([^"]+)"/.exec(String(output));
    const normalized = normalizeDeviceIdCandidate(match?.[1]);
    if (normalized) {
      logger?.debug(`Device ID from ioreg IOPlatformUUID: ${normalized}`);
      return normalized;
    }
  } catch (error) {
    logger?.debug('ioreg unavailable on macOS host', error);
  }

  try {
    const output = execCommand('system_profiler SPHardwareDataType', {
      timeout: 5000,
      encoding: 'utf-8',
    });
    const match = /Serial Number.*?:\s*(\S+)/.exec(String(output));
    const normalized = normalizeDeviceIdCandidate(match?.[1]);
    if (normalized) {
      logger?.debug(`Device ID from system_profiler serial: ${normalized}`);
      return normalized;
    }
  } catch (error) {
    logger?.debug('system_profiler unavailable on macOS host', error);
  }

  return null;
}

function readWin32HostDeviceId(execCommand: typeof execSync, logger?: DeviceIdLogger): string | null {
  try {
    const output = String(
      execCommand('wmic csproduct get uuid /value', {
        timeout: 5000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
    const match = /UUID\s*=\s*([0-9A-Fa-f-]{36})/.exec(output);
    const normalized = normalizeDeviceIdCandidate(match?.[1]);
    if (normalized && normalized.toUpperCase() !== 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF') {
      logger?.debug(`Device ID from wmic product UUID: ${normalized}`);
      return normalized;
    }
  } catch (error) {
    logger?.debug('wmic unavailable on Windows host', error);
  }

  try {
    const output = String(
      execCommand('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', {
        timeout: 5000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
    const match = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(output);
    const normalized = normalizeDeviceIdCandidate(match?.[1]);
    if (normalized) {
      logger?.debug(`Device ID from registry MachineGuid: ${normalized}`);
      return normalized;
    }
  } catch (error) {
    logger?.debug('registry MachineGuid unavailable on Windows host', error);
  }

  try {
    const output = String(
      execCommand('powershell -NoProfile -Command "(Get-CimInstance Win32_ComputerSystemProduct).UUID"', {
        timeout: 8000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ).trim();
    const normalized = normalizeDeviceIdCandidate(output);
    if (normalized && normalized.toUpperCase() !== 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF') {
      logger?.debug(`Device ID from Win32_ComputerSystemProduct UUID: ${normalized}`);
      return normalized;
    }
  } catch (error) {
    logger?.debug('Win32_ComputerSystemProduct UUID unavailable on Windows host', error);
  }

  return null;
}

function readPlatformHostDeviceId(execCommand: typeof execSync, logger?: DeviceIdLogger): string | null {
  if (process.platform === 'darwin') {
    return readDarwinHostDeviceId(execCommand, logger);
  }
  if (process.platform === 'win32') {
    return readWin32HostDeviceId(execCommand, logger);
  }
  return null;
}

function readDmidecodeSerial(execCommand: typeof execSync, logger?: DeviceIdLogger): string | null {
  try {
    const serial = execCommand('dmidecode -s system-serial-number', {
      timeout: 5000,
      encoding: 'utf-8',
    });
    const normalized = normalizeDeviceIdCandidate(serial);
    if (normalized) {
      logger?.debug(`Device ID from dmidecode: ${normalized}`);
      return normalized;
    }
    logger?.debug(`dmidecode returned unusable value: "${serial.trim()}", falling back`);
  } catch (error) {
    logger?.debug('dmidecode unavailable, falling back to systeminformation', error);
  }
  return null;
}

async function readSystemInformationUuid(
  readUuid: () => Promise<{ hardware?: string; os?: string }>,
  logger?: DeviceIdLogger,
): Promise<string | null> {
  const uuid = await readUuid().catch(() => ({ hardware: '', os: '' }));

  for (const candidate of [uuid.hardware, uuid.os]) {
    const normalized = normalizeDeviceIdCandidate(candidate);
    if (normalized) {
      logger?.debug(`Device ID from systeminformation: ${normalized}`);
      return normalized;
    }
  }

  return null;
}

function getOrCreateGeneratedDeviceId(dataDir: string, logger?: DeviceIdLogger): string {
  const stateDir = path.join(dataDir, 'state');
  const filePath = path.join(stateDir, 'generated-device-id');

  const existing = readFileDeviceId(filePath, logger);
  if (existing) {
    logger?.debug(`Device ID from generated fallback file: ${existing}`);
    return existing;
  }

  const generated = `generated-${randomUUID()}`;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(filePath, `${generated}\n`, { encoding: 'utf-8', mode: 0o666 });
  } catch (error) {
    logger?.warn(`Unable to persist generated device ID at ${filePath}; using in-memory fallback for this process`);
    logger?.debug('Failed to write generated device ID file', error);
  }

  logger?.warn(`Using generated device ID fallback: ${generated}`);
  return generated;
}

/**
 * Resolve a stable, non-empty device identifier for registration and Portal check-ins.
 * Hardware-backed IDs are preferred; a persisted generated UUID is the final fallback.
 */
export async function resolveDeviceId(options: ResolveDeviceIdOptions): Promise<string> {
  const { dataDir, logger } = options;
  const execCommand = options.execCommand ?? execSync;
  const readUuid = options.readUuid ?? (() => si.uuid());
  const envDeviceId = normalizeDeviceIdCandidate(options.envDeviceId ?? process.env.DEVICE_ID);
  if (envDeviceId) {
    logger?.debug(`Device ID from DEVICE_ID env var: ${envDeviceId}`);
    return envDeviceId;
  }

  const platformHostId = readPlatformHostDeviceId(execCommand, logger);
  if (platformHostId) return platformHostId;

  const dmidecodeSerial = readDmidecodeSerial(execCommand, logger);
  if (dmidecodeSerial) return dmidecodeSerial;

  const systemUuid = await readSystemInformationUuid(readUuid, logger);
  if (systemUuid) return systemUuid;

  const productUuid = readFileDeviceId('/sys/class/dmi/id/product_uuid', logger);
  if (productUuid) {
    logger?.debug(`Device ID from /sys/class/dmi/id/product_uuid: ${productUuid}`);
    return productUuid;
  }

  for (const machineIdPath of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    const machineId = readFileDeviceId(machineIdPath, logger);
    if (machineId) {
      logger?.debug(`Device ID from ${machineIdPath}: ${machineId}`);
      return machineId;
    }
  }

  return getOrCreateGeneratedDeviceId(dataDir, logger);
}
