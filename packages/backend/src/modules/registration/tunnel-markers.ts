import fs from 'node:fs';
import path from 'node:path';
import { TUNNEL_DIR, tunnelLeftoverMarkerPath, tunnelRegistrationMarkerPath } from '@/common/constants';
import { writeHealableTextFile } from '@/common/helpers/bind-mount-helpers';

/**
 * Non-secret files in the tunnel folder that say whether its token belongs to a registration.
 *
 * The desktop app, the CLI and the uninstallers read these files too, so their names and shapes
 * are shared with them and must not change.
 */

export interface TunnelRegistrationMarker {
  tunnelId: string | null;
  writtenAt: string;
}

export interface TunnelLeftoverMarker {
  tunnelId: string | null;
  foundAt: string;
}

export const tunnelTokenPath = () => path.join(TUNNEL_DIR, 'token');

export async function writeTunnelRegistrationMarker(tunnelId: string | null, now: Date = new Date()): Promise<void> {
  const marker: TunnelRegistrationMarker = { tunnelId: tunnelId || null, writtenAt: now.toISOString() };

  await writeHealableTextFile(tunnelRegistrationMarkerPath(), `${JSON.stringify(marker)}\n`, 0o644);
}

export async function removeTunnelRegistrationMarker(): Promise<void> {
  await removeIfPresent(tunnelRegistrationMarkerPath());
}

export async function writeTunnelLeftoverMarker(tunnelId: string | null, now: Date = new Date()): Promise<void> {
  const marker: TunnelLeftoverMarker = { tunnelId: tunnelId || null, foundAt: now.toISOString() };

  await writeHealableTextFile(tunnelLeftoverMarkerPath(), `${JSON.stringify(marker)}\n`, 0o644);
}

export async function removeTunnelLeftoverMarker(): Promise<void> {
  await removeIfPresent(tunnelLeftoverMarkerPath());
}

export function hasTunnelLeftoverMarker(): boolean {
  try {
    return fs.statSync(tunnelLeftoverMarkerPath()).isFile();
  } catch {
    return false;
  }
}

/**
 * Reads the tunnel ID out of a `cloudflared` tunnel token, which is base64-encoded JSON whose `t`
 * field is the tunnel ID. Returns null for anything else rather than guessing.
 */
export function tunnelIdFromToken(token: string): string | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(token.trim(), 'base64').toString('utf8'));

    if (decoded && typeof decoded === 'object' && typeof (decoded as { t?: unknown }).t === 'string') {
      const tunnelId = (decoded as { t: string }).t.trim();

      return tunnelId || null;
    }
  } catch {
    // Not a token this Hub can read; the marker records no tunnel ID.
  }

  return null;
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw error;
    }
  }
}
