import { describe, expect, it, vi } from 'vitest';
import type { PortalLogin } from '../lib/catalog-submit.js';
import { deletePortalDevice, findPortalDevice, listPortalDevices, reRegisterPortalDevice, requireManageLogin } from '../lib/fleet-devices.js';

/**
 * `cihub fleet devices` against Portal's device routes. Every request carries the stored token, the
 * organization is always explicit on a list, and a Portal that refuses says which of the two things
 * it can mean — the scope, or the org.
 */
const manage: PortalLogin = { token: 'cio_manage', orgId: 'org-1', orgSlug: 'bill-co', portalOrigin: 'https://portal.test', scope: 'device:manage' };
const pair: PortalLogin = { ...manage, token: 'cio_pair', scope: 'device:pair' };

function fetchAnswering(status: number, body: unknown) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch;
}

describe('requireManageLogin', () => {
  it('needs a device:manage login, and names the command that makes one', () => {
    expect(() => requireManageLogin(null)).toThrow(/cihub login --scope device:manage/);
    expect(() => requireManageLogin(pair)).toThrow(/has scope device:pair/);
    expect(requireManageLogin(manage)).toBe(manage);
  });
});

describe('listPortalDevices', () => {
  it("asks for the login's organization by default, with the token, and normalises the rows", async () => {
    // Portal answers `id` = the registration row and `deviceId` = the device; the device is what
    // its routes key on, and what a never-paired device is called (`inactive-<uuid>`). Picking `id`
    // made every release and re-register answer 404.
    const fetchImpl = fetchAnswering(200, {
      devices: [{ id: 'reg-1', deviceId: 'inactive-7', name: 'core-7', slug: 'core-7', status: 'inactive', lastSeenAt: null }],
    });
    const devices = await listPortalDevices({ login: manage, fetchImpl });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://portal.test/api/devices?organizationId=org-1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cio_manage');
    expect(devices).toEqual([
      {
        id: 'inactive-7',
        registrationId: 'reg-1',
        name: 'core-7',
        slug: 'core-7',
        status: 'inactive',
        organizationId: undefined,
        lastSeenAt: null,
        createdAt: null,
      },
    ]);
  });

  it('names the two things a 401 can mean', async () => {
    await expect(listPortalDevices({ login: manage, fetchImpl: fetchAnswering(401, { error: 'Unauthorized' }) })).rejects.toThrow(
      /device:manage login is required, and this Portal must accept it/,
    );
  });
});

describe('findPortalDevice', () => {
  const devices = [
    { id: 'd1', name: 'core-1', slug: 'core-1' },
    { id: 'd17', name: 'core-17', slug: 'core-17' },
    { id: 'd7', name: 'beta-red', slug: 'beta-red-2' },
  ];

  it('matches a name, slug or id exactly — never a prefix, because this precedes a delete', () => {
    expect(findPortalDevice(devices, 'core-1').device?.id).toBe('d1');
    expect(findPortalDevice(devices, 'CORE-17').device?.id).toBe('d17');
    expect(findPortalDevice(devices, 'beta-red-2').device?.id).toBe('d7');
    expect(findPortalDevice(devices, 'd7').device?.id).toBe('d7');
    expect(findPortalDevice(devices, 'core').why).toMatch(/no device/);
  });

  it('refuses an ambiguous target and lists the candidates', () => {
    const twins = [...devices, { id: 'd1b', name: 'core-1', slug: 'core-1-b' }];
    expect(findPortalDevice(twins, 'core-1').why).toMatch(/matches 2 devices.*use the id/);
  });
});

describe('deletePortalDevice / reRegisterPortalDevice', () => {
  it("DELETEs the device by id with the token, returning Portal's warnings", async () => {
    const fetchImpl = fetchAnswering(200, { success: true, warnings: ['dns release queued'] });
    const result = await deletePortalDevice({ login: manage, deviceId: 'd1', fetchImpl });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://portal.test/api/devices/d1');
    expect(init.method).toBe('DELETE');
    expect(result.warnings).toEqual(['dns release queued']);
  });

  it('explains a 403 as the owner-or-admin rule', async () => {
    await expect(
      deletePortalDevice({ login: manage, deviceId: 'd1', fetchImpl: fetchAnswering(403, { error: 'Insufficient permissions' }) }),
    ).rejects.toThrow(/owner or admin/);
  });

  it('re-register returns the replacement pairing code', async () => {
    const fetchImpl = fetchAnswering(200, { deviceId: 'd1', pairingCode: 'ABC123', status: 'inactive' });
    await expect(reRegisterPortalDevice({ login: manage, deviceId: 'd1', fetchImpl })).resolves.toEqual({ pairingCode: 'ABC123', deviceId: 'd1' });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://portal.test/api/devices/d1/re-register');
    expect(init.method).toBe('POST');
  });
});
