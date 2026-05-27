import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { FederationConfigService } from '../federation-config.service';
import { WebfingerController } from '../webfinger.controller';

describe('WebfingerController', () => {
  let controller: WebfingerController;
  let federationConfig: MockProxy<FederationConfigService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WebfingerController],
      providers: [{ provide: FederationConfigService, useValue: mock<FederationConfigService>() }],
    }).compile();

    controller = moduleRef.get(WebfingerController);
    federationConfig = moduleRef.get(FederationConfigService);
    federationConfig.getSettings.mockReturnValue({
      federationEnabled: true,
      federationDisplayName: 'Companion Hub',
      federationSummary: '',
      federationPreferredUsername: 'hub',
      federationManualApproval: false,
      federationPublishAppInstalls: false,
      federationPublishAppUpdates: false,
      federationPublishHubStatus: true,
      federationPublishAgentActivity: false,
      federationPublishSystemMetrics: false,
      federationRelayGhost: true,
      federationRelayForgejo: true,
      federationRelayNextcloud: false,
    });
    federationConfig.getBaseUrl.mockResolvedValue('https://example.com');
    federationConfig.getHostFromRequest.mockReturnValue('example.com');
  });

  it('returns a valid WebFinger response', async () => {
    federationConfig.ensureEnabled.mockReturnValue(undefined);
    federationConfig.isHttpsRequest.mockReturnValue(true);

    await expect(controller.getWebfinger({} as any, 'acct:hub@example.com')).resolves.toEqual({
      subject: 'acct:hub@example.com',
      links: [
        {
          rel: 'self',
          type: 'application/activity+json',
          href: 'https://example.com/api/activitypub/actor',
        },
      ],
    });
  });

  it('returns 404 for mismatched accounts', async () => {
    federationConfig.ensureEnabled.mockReturnValue(undefined);
    federationConfig.isHttpsRequest.mockReturnValue(true);

    await expect(controller.getWebfinger({} as any, 'acct:other@example.com')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects non-https requests', async () => {
    federationConfig.ensureEnabled.mockReturnValue(undefined);
    federationConfig.isHttpsRequest.mockReturnValue(false);

    await expect(controller.getWebfinger({} as any, 'acct:hub@example.com')).rejects.toBeInstanceOf(BadRequestException);
  });
});
