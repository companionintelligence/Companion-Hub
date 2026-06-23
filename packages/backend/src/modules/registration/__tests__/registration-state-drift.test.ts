import { vol } from 'memfs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildStateDriftResult, clearRegistrationKeysFromAppData, collectStaleHubDeviceIds } from '../registration-state-drift';

describe('registration-state-drift', () => {
  afterEach(() => {
    vol.reset();
  });

  it('collects stale HUB_DEVICE_ID values from nested app.env files', () => {
    vol.fromJSON({
      '/app-data/store/my-app/app.env': 'HUB_DEVICE_ID=stale-id-1\nNODE_ENV=production\n',
      '/app-data/store/other-app/app.env': 'HUB_DEVICE_ID=current-hardware\n',
    });

    expect(collectStaleHubDeviceIds('/app-data', 'current-hardware')).toEqual(['stale-id-1']);
  });

  it('strips registration keys from app.env files', async () => {
    vol.fromJSON({
      '/app-data/store/my-app/app.env': 'HUB_DEVICE_ID=stale\nHUB_API_KEY=secret\nKEEP=value\n',
    });

    const updated = await clearRegistrationKeysFromAppData('/app-data');

    expect(updated).toBe(1);
    expect(vol.readFileSync('/app-data/store/my-app/app.env', 'utf-8')).toBe('KEEP=value\n');
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
  });
});
