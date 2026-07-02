import { createAppUrn } from '@/common/helpers/app-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import type { AppInfo } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { fromPartial } from '@total-typescript/shoehorn';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppIntentSyncService } from '../app-intent-sync.service';

vi.mock('axios');

const mockedAxios = vi.mocked(axios, true);

const appUrn: AppUrn = createAppUrn('groceries', 'ci-store');

function infoWithIntents(): Pick<AppInfo, 'agents'> {
  return {
    agents: {
      intents: [
        {
          name: 'groceries.addItem',
          domain: 'groceries',
          title: 'Add grocery item',
          description: 'Add an item to the grocery list',
          binding: { kind: 'mcp', tool: 'add_item' },
        },
      ],
    },
  } as unknown as Pick<AppInfo, 'agents'>;
}

describe('app intent sync (Hub consumer for agents.intents[])', () => {
  let service: AppIntentSyncService;
  let logger = mock<LoggerService>();
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    logger = mock<LoggerService>();
    service = new AppIntentSyncService(logger);
    vi.clearAllMocks();
    // The service uses axios.isAxiosError to read response.status off failures.
    // The auto-mock stubs it out, so restore a predicate that recognizes our
    // shaped rejections (`{ isAxiosError: true }`).
    mockedAxios.isAxiosError = ((err: unknown): err is import('axios').AxiosError =>
      typeof err === 'object' && err !== null && (err as { isAxiosError?: boolean }).isAxiosError === true) as unknown as typeof axios.isAxiosError;
    delete process.env.CI_SERVER_URL;
    delete process.env.CI_SERVER_INTENT_TOKEN;
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('namespaces each app intent domain to app.<slug>.<domain>', () => {
    const collected = service.collectAppIntents(appUrn, infoWithIntents());
    expect(collected).toHaveLength(1);
    expect(collected[0]?.domain).toBe('app.groceries.groceries');
    expect(collected[0]?.name).toBe('app.groceries.groceries.addItem');
    // Non-domain fields are preserved.
    expect(collected[0]?.title).toBe('Add grocery item');
    expect(collected[0]?.binding?.tool).toBe('add_item');
  });

  it('returns no intents for an app that declares none', () => {
    expect(service.collectAppIntents(appUrn, { agents: undefined })).toEqual([]);
    expect(service.collectAppIntents(appUrn, fromPartial({ agents: { intents: [] } }))).toEqual([]);
  });

  it('skips app intent registration when CI_SERVER_URL is unset (standalone Hub)', async () => {
    await service.registerAppIntents(appUrn, infoWithIntents());
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  it('POSTs namespaced app intents to CI-Server on install', async () => {
    process.env.CI_SERVER_URL = 'http://ci-server:4000/';
    process.env.CI_SERVER_INTENT_TOKEN = 'shhh';
    mockedAxios.post.mockResolvedValue({ status: 200, data: {} });

    await service.registerAppIntents(appUrn, infoWithIntents());

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    // Trailing slash on the base URL is normalized away; domain is namespaced; token is sent.
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://ci-server:4000/api/intents/register',
      expect.objectContaining({
        appId: appUrn,
        appSlug: 'groceries',
        intents: expect.arrayContaining([expect.objectContaining({ domain: 'app.groceries.groceries' })]),
      }),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer shhh' }) }),
    );
  });

  it('does not POST when the app declares no intents', async () => {
    process.env.CI_SERVER_URL = 'http://ci-server:4000';
    await service.registerAppIntents(appUrn, { agents: undefined });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('swallows a 404 from an undeployed registration endpoint (does not throw into the install sink)', async () => {
    process.env.CI_SERVER_URL = 'http://ci-server:4000';
    mockedAxios.post.mockRejectedValue({ isAxiosError: true, response: { status: 404 } });
    await expect(service.registerAppIntents(appUrn, infoWithIntents())).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns but does not throw when CI-Server registration fails with a non-404 error', async () => {
    process.env.CI_SERVER_URL = 'http://ci-server:4000';
    mockedAxios.post.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.registerAppIntents(appUrn, infoWithIntents())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('DELETEs the app intent registration on uninstall', async () => {
    process.env.CI_SERVER_URL = 'http://ci-server:4000';
    mockedAxios.delete.mockResolvedValue({ status: 200, data: {} });

    await service.unregisterAppIntents(appUrn);

    expect(mockedAxios.delete).toHaveBeenCalledTimes(1);
    expect(mockedAxios.delete).toHaveBeenCalledWith(`http://ci-server:4000/api/intents/register/${encodeURIComponent(appUrn)}`, expect.anything());
  });

  it('skips app intent unregistration when CI_SERVER_URL is unset', async () => {
    await service.unregisterAppIntents(appUrn);
    expect(mockedAxios.delete).not.toHaveBeenCalled();
  });
});
