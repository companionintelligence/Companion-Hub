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

  it('names the organization in the body when one is given', async () => {
    const service = new PortalClientService(configuration);

    await service.whoisApps({ subject: 'portal-user-1', appIds: ['immich'], surface: 'hub', organizationId: 'org-hub' });

    expect(postMock).toHaveBeenCalledWith(
      'whois',
      { subject: 'portal-user-1', appIds: ['immich'], surface: 'hub', organizationId: 'org-hub' },
      expect.objectContaining({ headers: expect.objectContaining({ 'x-device-key': 'device-key-123' }) }),
    );
  });

  it('sends no organizationId at all when none is given', async () => {
    const service = new PortalClientService(configuration);

    await service.whoisApps({ subject: 'portal-user-1', appIds: ['_membership'], surface: 'hub' });

    const [, body] = postMock.mock.calls[0] ?? [];
    expect(body).toEqual({ subject: 'portal-user-1', appIds: ['_membership'], surface: 'hub' });
    expect(body).not.toHaveProperty('organizationId');
  });
});
