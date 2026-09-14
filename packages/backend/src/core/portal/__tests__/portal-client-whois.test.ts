import { ConfigurationService } from '@/core/config/configuration.service';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, MockProxy } from 'vitest-mock-extended';
import { PortalClientService } from '../portal-client.service';

/**
 * `whoisApps` — the device-key WhoIs every Hub grant and role read goes through. The organization
 * id is how a device registered to two organizations that paired it at the same moment tells Portal
 * which one it is; without it that device gets 409 `ORGANIZATION_REQUIRED` and no answer.
 */
vi.mock('axios');

describe('PortalClientService.whoisApps', () => {
  let configuration: MockProxy<ConfigurationService>;
  let postMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    configuration = mock<ConfigurationService>();
    configuration.getConfig.mockReturnValue({ ciCloudUrl: 'https://portal.example.com' } as any);
    configuration.get.mockImplementation((key: string) => (key === 'ciHubApiKey' ? 'device-key-123' : undefined));
    postMock = vi.fn().mockResolvedValue({ status: 200, data: { organizations: [] } });
    vi.mocked(axios.create).mockReturnValue({ post: postMock } as any);
  });

  it('names the organization in the body', async () => {
    const service = new PortalClientService(configuration);

    await service.whoisApps({ subject: 'portal-user-1', appIds: ['immich'], surface: 'hub', organizationId: 'org-hub' });

    expect(postMock).toHaveBeenCalledWith(
      'whois',
      { subject: 'portal-user-1', appIds: ['immich'], surface: 'hub', organizationId: 'org-hub' },
      expect.objectContaining({ headers: expect.objectContaining({ 'x-device-key': 'device-key-123' }) }),
    );
  });

  it("carries Portal's refusal code, and none for a refusal that is not Portal's", async () => {
    // Sign-in reads a 403 as "not a member" only when it is Portal's `GRANT_DENIED`: a firewall or proxy page in
    // front of Portal is not JSON, and says nothing about membership.
    const service = new PortalClientService(configuration);
    const ask = () => service.whoisApps({ subject: 'portal-user-1', appIds: ['_membership'], surface: 'hub', organizationId: 'org-hub' });

    postMock.mockResolvedValueOnce({
      status: 403,
      data: { error: 'Not a member of an organization this device is registered to', code: 'GRANT_DENIED' },
    });
    await expect(ask()).resolves.toMatchObject({ status: 403, code: 'GRANT_DENIED' });

    postMock.mockResolvedValueOnce({ status: 403, data: '<html><body>Access denied</body></html>' });
    const page = await ask();
    expect(page).toMatchObject({ status: 403, body: null });
    expect(page?.code).toBeUndefined();
  });
});
