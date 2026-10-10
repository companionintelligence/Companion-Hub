import fs from 'node:fs';
import path from 'node:path';
import type { CloudProviderConfig } from '@ci-hub/common/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { DATA_DIR } from '@/common/constants';
import type { LoggerService } from '@/core/logger/logger.service';
import { CloudFallbackService } from '@/modules/inference/cloud-fallback.service';
import { FactoryResetService } from '@/modules/system/factory-reset.service';
import { slowDisk } from '@/tests/utils/slow-disk';
import { ConfigurationService } from '../configuration.service';

/**
 * Two settings saves that overlap, on the suite's memfs disk with every write held between the open
 * that truncates settings.json and its bytes (see `slowDisk`).
 *
 * Settings > AI with a cloud key stored sends the provider (`{provider, enabled}`, as the key field is
 * masked) and then the preferences. On a Windows 11 Hub that pair left settings.json as a complete
 * object followed by the end of a longer one. Every later save failed on it, and the next restart
 * crash-looped on it.
 */

const SETTINGS_PATH = path.join(DATA_DIR, 'state', 'settings.json');

const STORED_KEY: CloudProviderConfig = {
  provider: 'openai',
  apiKey: 'sk-test-0000',
  enabled: true,
  baseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-4o',
};

/** Built without the constructor, as the other tests here do, so it needs no appliance env. */
function configurationWith(userSettings: Record<string, unknown>): ConfigurationService {
  return Object.assign(Object.create(ConfigurationService.prototype) as ConfigurationService, {
    logger: mock<LoggerService>(),
    config: { demoMode: false, userSettings: { ...userSettings } },
  });
}

function seed(settings: Record<string, unknown>): void {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

/** settings.json as the next boot reads it, which throws, as the boot did, when it does not parse. */
function onDisk(): unknown {
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('settings.json when two saves overlap', () => {
  it('keeps the file whole after Save AI Settings with a cloud key stored, with the provider and the new preferences in it', async () => {
    seed({ ciHubApiKey: 'portal-device-key', inferenceBackend: 'ollama', inferenceCloudProviders: [STORED_KEY] });
    const configuration = configurationWith({ inferenceBackend: 'ollama', inferenceCloudProviders: [STORED_KEY] });
    const cloudFallback = new CloudFallbackService(mock<LoggerService>(), configuration);
    cloudFallback.onModuleInit();
    // The provider's write reaches the disk first and is the slow one.
    const disk = slowDisk(({ index }) => (index === 0 ? 50 : 5));

    // What ai-settings.tsx does: wait for the provider POST to answer, then send the preferences.
    await cloudFallback.setProvider({ provider: 'openai', enabled: true, defaultModel: 'gpt-4o' });
    await configuration.setInferencePreferences('ollama', 'nemotron-3-nano:30b', 'nomic-embed-text');
    await disk.idle();

    expect(onDisk()).toEqual({
      ciHubApiKey: 'portal-device-key',
      inferenceBackend: 'ollama',
      inferenceCloudProviders: [STORED_KEY],
      inferenceModel: 'nemotron-3-nano:30b',
      inferenceEmbeddingModel: 'nomic-embed-text',
    });
  });

  it('keeps both of two saves that arrive together, not only the one that lands last', async () => {
    seed({ ciHubApiKey: 'portal-device-key' });
    const configuration = configurationWith({});
    const disk = slowDisk(({ index }) => (index === 0 ? 50 : 5));

    // Two requests at once, say a Settings page save and a Hub Pool switch from another tab.
    await Promise.all([configuration.setUserSettings({ guestDashboard: true }), configuration.setHubPoolPreferences({ poolMdnsEnabled: true })]);
    await disk.idle();

    expect(onDisk()).toEqual({ ciHubApiKey: 'portal-device-key', guestDashboard: true, hubPoolMdnsEnabled: true });
  });

  it('makes a factory reset wait for a save already under way, which would otherwise write the old settings back', async () => {
    seed({ ciHubApiKey: 'portal-device-key', guestDashboard: true });
    const configuration = configurationWith({});
    const factoryReset = Object.assign(Object.create(FactoryResetService.prototype) as FactoryResetService, { logger: mock<LoggerService>() });
    // The save is the slow write, the reset's `{}` the quick one.
    const disk = slowDisk(({ data }) => (data === '{}' ? 5 : 50));

    const save = configuration.setUserSettings({ allowAutoThemes: true });
    await factoryReset.resetSettings();
    await save;
    await disk.idle();

    expect(onDisk()).toEqual({});
  });
});
