import { ConfigurationService } from '@/core/config/configuration.service';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, MockProxy } from 'vitest-mock-extended';
import { PortalClientService } from '../portal-client.service';

/**
 * `fetchDispatchDevices` — the Portal leg of Hub Pool discovery (`hub-pool-discovery.service.ts`).
 * Until 2026-09-08 this called Portal's session-authenticated `GET /devices`, which a device key can
 * never pass, and the 401 was swallowed silently: the whole leg returned nothing regardless of what
 * Portal actually knew, and nothing here caught it because this method had zero direct test coverage.
 * `GET /devices/pool-peers` is the device-authenticated replacement — this file exists so a future
 * regression here fails a test instead of failing silently in production again.
 */
vi.mock('axios');

describe('PortalClientService.fetchDispatchDevices', () => {
  let configuration: MockProxy<ConfigurationService>;
  let getMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    configuration = mock<ConfigurationService>();
    configuration.getConfig.mockReturnValue({ ciCloudUrl: 'https://portal.example.com' } as any);
    getMock = vi.fn();
    vi.mocked(axios.create).mockReturnValue({ get: getMock } as any);
  });

  function makeService(apiKey: string | undefined) {
    configuration.get.mockImplementation((key: string) => (key === 'ciHubApiKey' ? apiKey : undefined));
    return new PortalClientService(configuration);
  }

  it('calls the device-authenticated pool-peers route, not the session-only devices listing', async () => {
    getMock.mockResolvedValue({ status: 200, data: { devices: [] } });
    const service = makeService('device-key-123');

    await service.fetchDispatchDevices();

    expect(getMock).toHaveBeenCalledWith('devices/pool-peers', expect.anything());
    const [, options] = getMock.mock.calls[0] ?? [];
    expect(options.headers).toMatchObject({ 'x-device-key': 'device-key-123' });
  });

  it('returns the devices array from a { devices: [...] } response', async () => {
    const devices = [{ id: 'peer-1', tailscaleDns: 'peer-1.example-tailnet.ts.net' }];
    getMock.mockResolvedValue({ status: 200, data: { devices } });
    const service = makeService('device-key-123');

    await expect(service.fetchDispatchDevices()).resolves.toEqual(devices);
  });

  it('never calls Portal at all without a configured device key', async () => {
    const service = makeService(undefined);

    const result = await service.fetchDispatchDevices();

    expect(result).toEqual([]);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('degrades to an empty list rather than throwing when Portal is unreachable', async () => {
    getMock.mockRejectedValue(new Error('network error'));
    const service = makeService('device-key-123');

    await expect(service.fetchDispatchDevices()).resolves.toEqual([]);
  });

  it('degrades to an empty list on a non-2xx response (e.g. the old 401 this route used to always return)', async () => {
    getMock.mockResolvedValue({ status: 401, data: { error: 'Unauthorized' } });
    const service = makeService('device-key-123');

    await expect(service.fetchDispatchDevices()).resolves.toEqual([]);
  });
});
