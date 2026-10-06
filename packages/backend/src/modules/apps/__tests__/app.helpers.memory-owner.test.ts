import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { ForwardAuthIdentityResolver } from '@/modules/auth/forward-auth-identity.resolver';
import { EnvUtils } from '@/modules/env/env.utils';
import { RegistrationService } from '@/modules/registration/registration.service';
import { FederatedIdentityRepository } from '@/modules/user/federated-identity.repository';
import { UserRepository } from '@/modules/user/user.repository';
import { Test } from '@nestjs/testing';
import type { AppInfo } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { fromPartial } from '@total-typescript/shoehorn';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';
import { AppFilesManager } from '../app-files-manager';
import { AppHelpers } from '../app.helpers';

const DIRECTORY = 'urn:ci-hub:6f1c2a4e-2f3b-4c5d-8e9f-0a1b2c3d4e5f';
const OWNER_PUBLIC_ID = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';

/**
 * Companion Memory gets this Hub's owner in its environment, so only the owner can create Memory's
 * first account. Only the official Memory: these name a person.
 */
describe('AppHelpers: Companion Memory owner environment', () => {
  let appHelpers: AppHelpers;
  let appFilesManager: MockProxy<AppFilesManager>;
  let envUtils: MockProxy<EnvUtils>;
  let logger: MockProxy<LoggerService>;
  let envMap: Map<string, string>;

  const users = { getFirstOperator: vi.fn() };
  const federated = { findByUserId: vi.fn() };
  const identities = { stableIdFor: vi.fn() };

  const memoryUrn: AppUrn = createAppUrn('ci-memory', 'ci-marketplace');
  const otherOfficialUrn: AppUrn = createAppUrn('importer', 'ci-marketplace');
  const lookalikeUrn: AppUrn = createAppUrn('ci-memory', 'sketchy-store');

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppHelpers,
        { provide: UserRepository, useValue: users },
        { provide: FederatedIdentityRepository, useValue: federated },
        { provide: ForwardAuthIdentityResolver, useValue: identities },
      ],
    })
      .useMocker(mock)
      .compile();

    appHelpers = moduleRef.get(AppHelpers);
    appFilesManager = moduleRef.get(AppFilesManager);
    envUtils = moduleRef.get(EnvUtils);
    logger = moduleRef.get(LoggerService);
    const config = moduleRef.get<MockProxy<ConfigurationService>>(ConfigurationService);
    const filesystem = moduleRef.get<MockProxy<FilesystemService>>(FilesystemService);
    const registrationService = moduleRef.get<MockProxy<RegistrationService>>(RegistrationService);
    const apiKeys = moduleRef.get<MockProxy<ApiKeyService>>(ApiKeyService);

    config.getConfig.mockReturnValue(
      fromPartial({
        internalIp: '192.168.1.10',
        envFilePath: '/data/.env',
        rootFolderHost: '/opt/ci-hub',
        domain: 'example.com',
        ciHubApiKey: 'hub-api-key',
        userSettings: { appDataPath: '/opt/ci-hub', domain: 'example.com' },
      }),
    );
    envMap = new Map<string, string>();
    envUtils.envStringToMap.mockImplementation(() => envMap);
    envUtils.envMapToString.mockReturnValue('');
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app.env', content: '' });
    filesystem.readTextFile.mockResolvedValue('');
    registrationService.getDeviceId.mockResolvedValue('hub-device-id');
    apiKeys.provisionManagedKey.mockResolvedValue('minted-managed-key');

    users.getFirstOperator.mockResolvedValue({ id: 1, username: 'owner@example.com' });
    identities.stableIdFor.mockResolvedValue({ issuer: DIRECTORY, userId: OWNER_PUBLIC_ID });
    federated.findByUserId.mockResolvedValue([{ issuer: 'https://hub.ci.computer', subject: 'portal-owner' }]);
  });

  const run = async (urn: AppUrn) => {
    appFilesManager.getInstalledAppInfo.mockResolvedValue(
      fromPartial<AppInfo>({ id: urn.split(':')[0], urn, name: 'Fixture App', port: 8642, exposable: true, form_fields: [] }),
    );
    await appHelpers.generateEnvFile(urn, {});
  };

  const ownerKeys = () => [...envMap.keys()].filter((key) => key.startsWith('CI_OWNER_'));

  it("names the Hub's owner to Companion Memory", async () => {
    await run(memoryUrn);

    expect(envMap.get('CI_OWNER_EMAIL')).toBe('owner@example.com');
    expect(envMap.get('CI_OWNER_HUB_ISSUER')).toBe(DIRECTORY);
    expect(envMap.get('CI_OWNER_HUB_SUBJECT')).toBe(OWNER_PUBLIC_ID);
    expect(envMap.get('CI_OWNER_PORTAL_ISSUER')).toBe('https://hub.ci.computer');
    expect(envMap.get('CI_OWNER_PORTAL_SUBJECT')).toBe('portal-owner');
    expect(identities.stableIdFor).toHaveBeenCalledWith(1);
    expect(federated.findByUserId).toHaveBeenCalledWith(1);
  });

  it.each([
    ['another official app', otherOfficialUrn],
    ['an app claiming to be Memory from another store', lookalikeUrn],
  ])('names nobody to %s', async (_label, urn) => {
    await run(urn);

    expect(ownerKeys()).toEqual([]);
    expect(users.getFirstOperator).not.toHaveBeenCalled();
  });

  it('names nobody before the Hub has an owner', async () => {
    users.getFirstOperator.mockResolvedValue(undefined);

    await run(memoryUrn);

    expect(ownerKeys()).toEqual([]);
  });

  it('still writes the environment when the owner cannot be read, without one', async () => {
    users.getFirstOperator.mockRejectedValue(new Error('database unavailable'));

    await run(memoryUrn);

    expect(ownerKeys()).toEqual([]);
    expect(appFilesManager.writeAppEnv).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/could not read the Hub owner/));
  });
});
