import fs from 'node:fs';
import path from 'node:path';

export type StateDriftReason =
  | 'local_unregistered_portal_active'
  | 'stale_hub_device_id_in_app_data'
  | 'stale_tunnel_token'
  | 'orphaned_local_db_registration';

export interface StateDriftSignal {
  reason: StateDriftReason;
  detail?: string;
}

export interface RegistrationStateDrift {
  detected: boolean;
  hardwareDeviceId: string;
  localRegistered: boolean;
  /** null when Companion Portal is unreachable or not configured */
  portalDeviceActive: boolean | null;
  /**
   * Whether this Hub holds a move key from its last pairing: with an accepted device key, what lets it
   * move itself to another organization. A Hub paired before move keys has none, and is not offered
   * the move until it has paired again where it is.
   */
  hasMoveKey: boolean;
  staleAppEnvDeviceIds: string[];
  signals: StateDriftSignal[];
  hasStaleTunnelToken: boolean;
}

const HUB_DEVICE_ID_KEY = 'HUB_DEVICE_ID';
const HUB_API_KEY_KEY = 'HUB_API_KEY';

/**
 * The `app.env` path of every app folder under app-data, whether or not the file exists.
 *
 * The Hub writes each app's env file at `<store>/<app>/app.env` (`AppFilesManager.writeAppEnv`), so
 * listing app-data and each store folder finds them all. Everything below an app folder is the app's
 * own data, and walking it went through every file an app keeps. On a Windows Hub, app-data is on
 * `/mnt/c` and each lookup is a round trip to Windows: one app with 13,328 cache files made a single
 * drift check take 27 s.
 */
async function listAppEnvPaths(appDataDir: string): Promise<string[]> {
  const envPaths: string[] = [];

  for (const store of await listSubdirectories(appDataDir)) {
    const storeDir = path.join(appDataDir, store);
    for (const app of await listSubdirectories(storeDir)) {
      envPaths.push(path.join(storeDir, app, 'app.env'));
    }
  }

  return envPaths;
}

async function listSubdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Parse HUB_DEVICE_ID values from the app.env of each app under app-data. */
export async function collectStaleHubDeviceIds(appDataDir: string, currentHardwareId: string): Promise<string[]> {
  const stale = new Set<string>();

  for (const envPath of await listAppEnvPaths(appDataDir)) {
    const deviceId = await readEnvValue(envPath, HUB_DEVICE_ID_KEY);
    if (deviceId && deviceId !== currentHardwareId) {
      stale.add(deviceId);
    }
  }

  return [...stale];
}

async function readEnvValue(filePath: string, key: string): Promise<string | null> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const eq = trimmed.indexOf('=');
      if (eq <= 0) {
        continue;
      }
      const name = trimmed.slice(0, eq).trim();
      if (name !== key) {
        continue;
      }
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value || null;
    }
  } catch {
    // Missing or unreadable app.env — skip.
  }
  return null;
}

/** Remove registration-related keys from the app.env of each app under app-data. */
export async function clearRegistrationKeysFromAppData(appDataDir: string): Promise<number> {
  let updated = 0;

  for (const envPath of await listAppEnvPaths(appDataDir)) {
    if (await stripRegistrationKeysFromEnvFile(envPath)) {
      updated += 1;
    }
  }

  return updated;
}

async function stripRegistrationKeysFromEnvFile(filePath: string): Promise<boolean> {
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return false;
  }

  const lines = content.split('\n');
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return true;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      return true;
    }
    const name = trimmed.slice(0, eq).trim();
    return name !== HUB_DEVICE_ID_KEY && name !== HUB_API_KEY_KEY;
  });

  if (filtered.length === lines.length) {
    return false;
  }

  const next = filtered.join('\n');
  await fs.promises.writeFile(filePath, next.endsWith('\n') ? next : `${next}\n`, 'utf-8');
  return true;
}

export function buildStateDriftResult(input: {
  hardwareDeviceId: string;
  localRegistered: boolean;
  portalDeviceActive: boolean | null;
  staleAppEnvDeviceIds: string[];
  hasStaleTunnelToken: boolean;
  hasOrphanedDbRegistration?: boolean;
  hasMoveKey?: boolean;
}): RegistrationStateDrift {
  const signals: StateDriftSignal[] = [];

  if (!input.localRegistered && input.portalDeviceActive === true) {
    signals.push({
      reason: 'local_unregistered_portal_active',
      detail: 'CI Portal recognizes this hardware device ID but the Hub is unregistered locally.',
    });
  }

  for (const staleId of input.staleAppEnvDeviceIds) {
    signals.push({
      reason: 'stale_hub_device_id_in_app_data',
      detail: staleId,
    });
  }

  if (!input.localRegistered && input.hasStaleTunnelToken) {
    signals.push({
      reason: 'stale_tunnel_token',
    });
  }

  if (input.hasOrphanedDbRegistration) {
    signals.push({
      reason: 'orphaned_local_db_registration',
    });
  }

  return {
    detected: signals.length > 0,
    hardwareDeviceId: input.hardwareDeviceId,
    localRegistered: input.localRegistered,
    portalDeviceActive: input.portalDeviceActive,
    hasMoveKey: input.hasMoveKey === true,
    staleAppEnvDeviceIds: input.staleAppEnvDeviceIds,
    signals,
    hasStaleTunnelToken: input.hasStaleTunnelToken,
  };
}
