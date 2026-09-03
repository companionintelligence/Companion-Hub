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
  staleAppEnvDeviceIds: string[];
  signals: StateDriftSignal[];
  hasStaleTunnelToken: boolean;
}

const HUB_DEVICE_ID_KEY = 'HUB_DEVICE_ID';
const HUB_API_KEY_KEY = 'HUB_API_KEY';

/** Parse HUB_DEVICE_ID values from app.env files under app-data. */
export function collectStaleHubDeviceIds(appDataDir: string, currentHardwareId: string): string[] {
  const stale = new Set<string>();

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (entry.name !== 'app.env') {
        continue;
      }

      const deviceId = readEnvValue(fullPath, HUB_DEVICE_ID_KEY);
      if (deviceId && deviceId !== currentHardwareId) {
        stale.add(deviceId);
      }
    }
  };

  walk(appDataDir);
  return [...stale];
}

function readEnvValue(filePath: string, key: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
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

/** Remove registration-related keys from every app.env under app-data. */
export async function clearRegistrationKeysFromAppData(appDataDir: string): Promise<number> {
  let updated = 0;

  const walk = async (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (entry.name !== 'app.env') {
        continue;
      }

      const changed = await stripRegistrationKeysFromEnvFile(fullPath);
      if (changed) {
        updated += 1;
      }
    }
  };

  await walk(appDataDir);
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
    staleAppEnvDeviceIds: input.staleAppEnvDeviceIds,
    signals,
    hasStaleTunnelToken: input.hasStaleTunnelToken,
  };
}
