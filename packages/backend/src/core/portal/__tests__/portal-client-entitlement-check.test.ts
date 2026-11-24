import { ConfigurationService } from '@/core/config/configuration.service';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, MockProxy } from 'vitest-mock-extended';
import { PortalClientService } from '../portal-client.service';

vi.mock('axios');

describe('PortalClientService.checkAppEntitlement', () => {
  let configuration: MockProxy<ConfigurationService>;
  let getMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    configuration = mock<ConfigurationService>();
    configuration.getConfig.mockReturnValue({ ciCloudUrl: 'https://portal.example.com' } as any);
    configuration.get.mockImplementation((key: string) => (key === 'ciHubApiKey' ? 'device-key-123' : undefined));
    getMock = vi.fn().mockResolvedValue({ status: 200, data: { entitled: true, reason: 'org_entitled' } });
    vi.mocked(axios.create).mockReturnValue({ get: getMock } as any);
  });

  it('names the organization in the query string', async () => {
    await new PortalClientService(configuration).checkAppEntitlement('immich', 'org-hub');

    expect(getMock).toHaveBeenCalledWith('entitlements/check', expect.objectContaining({ params: { appId: 'immich', organizationId: 'org-hub' } }));
  });

  it('sends no organizationId at all when this Hub does not know it, never an empty one', async () => {
    await new PortalClientService(configuration).checkAppEntitlement('immich', null);

    expect(getMock.mock.calls[0]?.[1].params).toEqual({ appId: 'immich' });
  });

  it("carries the code of Portal's refusal", async () => {
    getMock.mockResolvedValue({ status: 409, data: { error: 'name the one you mean', code: 'ORGANIZATION_REQUIRED' } });

    await expect(new PortalClientService(configuration).checkAppEntitlement('immich', null)).resolves.toMatchObject({
      status: 409,
      code: 'ORGANIZATION_REQUIRED',
    });
  });
});
