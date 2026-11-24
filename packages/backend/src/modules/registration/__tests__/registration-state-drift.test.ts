import fs from 'node:fs';
import { vol } from 'memfs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildStateDriftResult, clearRegistrationKeysFromAppData, collectStaleHubDeviceIds } from '../registration-state-drift';

/**
 * An app-data tree like a Windows Hub's: each app's `app.env` at `<store>/<app>/app.env`, and below
 * it the app's own data. OpenClaw's held 13,328 files there, and an app may keep a file of its own
 * named `app.env` among them.
 */
const APP_DATA_WITH_APP_FILES = {
  '/app-data/ci-marketplace/openclaw/app.env': 'HUB_DEVICE_ID=stale-id-1\nHUB_API_KEY=secret\nKEEP=value\n',
  '/app-data/ci-marketplace/openclaw/data/.openclaw/cache/a/b/entry.json': '{}',
  '/app-data/ci-marketplace/openclaw/data/.openclaw/workspace/app.env': 'HUB_DEVICE_ID=written-by-the-app\nHUB_API_KEY=the-apps-own\n',
  '/app-data/_user/my-app/app.env': 'HUB_DEVICE_ID=stale-id-2\nAPP_PORT=8080\n',
  '/app-data/_user/my-app/data/notes.txt': 'notes',
};

/**
 * Watches every directory listing, sync or not. Returns the directories listed so far, sorted, with
 * forward slashes so the list reads the same on Windows.
 */
function watchDirectoryListings(): () => string[] {
  const readdirSync = vi.spyOn(fs, 'readdirSync');
  const readdir = vi.spyOn(fs.promises, 'readdir');

  return () => [...readdirSync.mock.calls, ...readdir.mock.calls].map(([dir]) => String(dir).replaceAll('\\', '/')).sort();
}

describe('registration-state-drift', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vol.reset();
  });

  it('collects stale HUB_DEVICE_ID values from nested app.env files', async () => {
    vol.fromJSON({
      '/app-data/store/my-app/app.env': 'HUB_DEVICE_ID=stale-id-1\nNODE_ENV=production\n',
      '/app-data/store/other-app/app.env': 'HUB_DEVICE_ID=current-hardware\n',
    });

    expect(await collectStaleHubDeviceIds('/app-data', 'current-hardware')).toEqual(['stale-id-1']);
  });

  it("lists app-data and its store folders to find each app.env, and never an app's own data", async () => {
    vol.fromJSON(APP_DATA_WITH_APP_FILES);
    const directoriesListed = watchDirectoryListings();

    const staleIds = await collectStaleHubDeviceIds('/app-data', 'current-hardware');

    expect(directoriesListed()).toEqual(['/app-data', '/app-data/_user', '/app-data/ci-marketplace']);
    expect([...staleIds].sort()).toEqual(['stale-id-1', 'stale-id-2']);
  });

  it('collects stale device IDs without a synchronous read, which would hold up every other request', async () => {
    vol.fromJSON(APP_DATA_WITH_APP_FILES);
    const readdirSync = vi.spyOn(fs, 'readdirSync');
    const readFileSync = vi.spyOn(fs, 'readFileSync');

    await collectStaleHubDeviceIds('/app-data', 'current-hardware');

    expect(readdirSync).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('strips registration keys from app.env files', async () => {
    vol.fromJSON({
      '/app-data/store/my-app/app.env': 'HUB_DEVICE_ID=stale\nHUB_API_KEY=secret\nKEEP=value\n',
    });

    const updated = await clearRegistrationKeysFromAppData('/app-data');

    expect(updated).toBe(1);
    expect(vol.readFileSync('/app-data/store/my-app/app.env', 'utf-8')).toBe('KEEP=value\n');
  });

  it("strips registration keys from each app's app.env without listing the app's own data, or editing a file of the app's", async () => {
    vol.fromJSON(APP_DATA_WITH_APP_FILES);
    const directoriesListed = watchDirectoryListings();

    const updated = await clearRegistrationKeysFromAppData('/app-data');

    expect(directoriesListed()).toEqual(['/app-data', '/app-data/_user', '/app-data/ci-marketplace']);
    expect(updated).toBe(2);
    expect(vol.readFileSync('/app-data/ci-marketplace/openclaw/app.env', 'utf-8')).toBe('KEEP=value\n');
    expect(vol.readFileSync('/app-data/_user/my-app/app.env', 'utf-8')).toBe('APP_PORT=8080\n');
    expect(vol.readFileSync('/app-data/ci-marketplace/openclaw/data/.openclaw/workspace/app.env', 'utf-8')).toBe(
      APP_DATA_WITH_APP_FILES['/app-data/ci-marketplace/openclaw/data/.openclaw/workspace/app.env'],
    );
  });

  it('builds drift result when portal recognizes hardware but hub is unregistered', () => {
    const result = buildStateDriftResult({
      hardwareDeviceId: 'hw-123',
      localRegistered: false,
      portalDeviceActive: true,
      staleAppEnvDeviceIds: ['old-id'],
      hasStaleTunnelToken: true,
      hasOrphanedDbRegistration: true,
    });

    expect(result.detected).toBe(true);
    expect(result.signals.map((s) => s.reason)).toEqual([
      'local_unregistered_portal_active',
      'stale_hub_device_id_in_app_data',
      'stale_tunnel_token',
      'orphaned_local_db_registration',
    ]);
  });

  it('returns detected=false when no drift signals apply', () => {
    const result = buildStateDriftResult({
      hardwareDeviceId: 'hw-123',
      localRegistered: false,
      portalDeviceActive: false,
      staleAppEnvDeviceIds: [],
      hasStaleTunnelToken: false,
      hasOrphanedDbRegistration: false,
    });

    expect(result.detected).toBe(false);
    expect(result.signals).toEqual([]);
    // Not said is not held: only a Hub that reports a move key is offered the move.
    expect(result.hasMoveKey).toBe(false);
  });

  it('passes on that the Hub holds a move key, which is no drift by itself', () => {
    const result = buildStateDriftResult({
      hardwareDeviceId: 'hw-123',
      localRegistered: false,
      portalDeviceActive: null,
      staleAppEnvDeviceIds: [],
      hasStaleTunnelToken: false,
      hasMoveKey: true,
    });

    expect(result.hasMoveKey).toBe(true);
    expect(result.detected).toBe(false);
  });
});
