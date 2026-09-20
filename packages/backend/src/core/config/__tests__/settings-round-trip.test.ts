import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { InternalServerErrorException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { type PersistedSettings, parsePersistedSettings, settingsFileSchema } from '@/app.dto';
import { DATA_DIR } from '@/common/constants';
import { SystemUpdateService } from '@/modules/system-update/system-update.service';
import { ConfigurationService } from '../configuration.service';

/**
 * Every settings write is a read-modify-write of the whole of `state/settings.json`, and the read
 * half parses the file through `settingsFileSchema`, which strips every key it does not declare.
 * So a key the Hub writes but the schema does not declare survives only until the next unrelated
 * write, and nothing reports that it went.
 *
 * On 2026-09-17 auto-update was switched off on all 16 fleet Hubs through
 * POST /api/system/update/auto-updates, which stored `autoUpdates: false`. `autoUpdates` was not in
 * the schema, so the next Settings page save, telemetry switch, inference-preferences save, cloud
 * provider change, pool pin, or Portal pairing callback on any of those Hubs would have written the
 * file back without it, and the daily auto-updater reads a missing key as "on". Before the fix, every
 * writer below except the auto-update switch itself failed with exactly `['autoUpdates']` lost.
 *
 * This suite runs every real writer against a file that holds one valid value for every declared
 * key, through the real parse and the real file writer (the global memfs mock stands in for disk),
 * and asserts that nothing the writer did not target went missing or changed.
 */

const SETTINGS_PATH = path.join(DATA_DIR, 'state', 'settings.json');

/**
 * One valid, already-canonical value for every key settings.json can hold. Canonical matters: a value
 * the schema transforms (a numeric string, an untrimmed id, a lower-case zone) would come back
 * different and read as a drop. The first test fails when a key is added to the schema without an
 * entry here, which is the point: a new key has to be proved to survive before it can ship.
 */
const ONE_OF_EVERY_KEY: Required<PersistedSettings> = {
  advancedSettings: true,
  allowAutoThemes: false,
  allowErrorMonitoring: false,
  appDataPath: '/srv/ci-hub',
  appsRepoUrl: 'https://github.com/companionintelligence/ci-hub-appstore.git',
  defaultAppCpuLimit: '2',
  defaultAppMemoryLimit: '4g',
  autoAllocateAppResources: false,
  demoMode: false,
  disablePasswordReset: true,
  dnsIp: '1.1.1.1',
  domain: 'example.com',
  eventsTimeout: 5,
  forwardAuthUrl: 'http://auth.example.com/',
  guestDashboard: true,
  internalIp: '10.0.0.2',
  listenIp: '0.0.0.0',
  localDomain: 'ci.localhost',
  logLevel: 'warn',
  maxBackups: 3,
  persistTraefikConfig: true,
  port: 8080,
  postgresPort: 5433,
  sslPort: 8443,
  timeZone: 'Europe/Berlin',
  experimental_insecureCookie: true,
  themeBase: 'slate',
  themeColor: 'red',
  ciHubApiKey: 'portal-device-key',
  ciHubMoveKey: 'portal-move-key',
  ciHubOrganizationId: 'org-1',
  ciHubOrganizationSlug: 'acme',
  ciHubOrganizationLabel: 'Acme',
  ciHubDeviceSlug: 'core-2',
  ciHubHubSubdomain: 'hub-core-2-acme',
  inferenceBackend: 'vllm',
  inferenceModel: 'qwen3.6:27b',
  inferenceEmbeddingModel: 'nomic-embed-text',
  inferenceVisionModel: 'qwen2.5vl:7b',
  inferenceVllmApiKey: 'vllm-key',
  inferenceVllmUrl: 'http://vllm:8000',
  inferenceMtplxUrl: 'http://mtplx:8080',
  inferenceDsparkUrl: 'http://dspark:8080',
  hubPoolEnabled: false,
  hubPoolOutboundEnabled: false,
  hubPoolInboundEnabled: false,
  hubPoolLocalAffinity: 4,
  hubPoolHealthPollSeconds: 60,
  hubPoolRequireSignedPeers: true,
  hubPoolShareContainerStats: false,
  // The default is on, so pin the non-default here: a fixture equal to the default would pass
  // even if the key stopped round-tripping.
  hubPoolRouteAppsAlways: false,
  hubPoolPressureWeight: 2,
  // #1480: the per-node prompt ceiling. A key added to the schema without a fixture here fails the
  // first test in this file, which is how this one was caught when #1480 landed first.
  hubPoolMaxPromptTokens: 16000,
  // Non-default, like the rest: the default is 10_000.
  hubPoolProbeSnapshotTtlMs: 2500,
  inferenceSupervisionMode: 'observe',
  inferenceSupervisionPollSeconds: 45,
  hubPoolPins: [{ scope: 'model', model: 'qwen3.6:27b', targetKind: 'peer', peerId: 'peer-1', mode: 'prefer' }],
  inferenceCloudProviders: [{ provider: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o', enabled: false }],
  autoUpdates: false,
};

type Writers = {
  configuration: {
    setUserSettings(settings: PersistedSettings): Promise<void>;
    setInferencePreferences(backend: string, model?: string | null): Promise<unknown>;
    setInferenceCloudProviders(providers: unknown[]): Promise<unknown>;
    setHubPoolPreferences(preferences: Record<string, unknown>): Promise<unknown>;
  };
  systemUpdate: SystemUpdateService;
  /** ConfigurationService's logger, where the merge reports what it dropped and why a write failed. */
  logger: Record<'warn' | 'error' | 'info' | 'debug', ReturnType<typeof vi.fn>>;
};

function makeWriters(): Writers {
  // ConfigurationService's constructor validates a full appliance environment, so the instance is
  // built bare. Every method under test is the real one, and so are the parse and the file writer.
  const configuration = Object.create(ConfigurationService.prototype) as Writers['configuration'] & Record<string, unknown>;
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  configuration.logger = logger;
  configuration.config = { demoMode: false, userSettings: {} };
  const systemUpdateLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const systemUpdate = new SystemUpdateService(systemUpdateLogger as never, configuration as never, {} as never);
  return { configuration, systemUpdate, logger };
}

/** Everything a logger mock was handed, as one string, so a test can assert what never reached a log. */
function logged(logger: Writers['logger']): string {
  return JSON.stringify(Object.values(logger).flatMap((fn) => fn.mock.calls));
}

/**
 * The writes the Hub actually makes, one per call site that reaches settings.json. `writes` is what
 * each one is expected to set; every other key has to come back exactly as it was.
 */
const WRITERS: Array<{ name: string; write: (w: Writers) => Promise<unknown>; writes: PersistedSettings }> = [
  { name: 'the Settings page save', write: (w) => w.configuration.setUserSettings({ themeColor: 'blue' }), writes: { themeColor: 'blue' } },
  {
    name: 'the telemetry switch',
    write: (w) => w.configuration.setUserSettings({ allowErrorMonitoring: true }),
    writes: { allowErrorMonitoring: true },
  },
  {
    name: 'an inference-preferences save',
    write: (w) => w.configuration.setInferencePreferences('ollama', 'llama3.2:3b'),
    writes: { inferenceBackend: 'ollama', inferenceModel: 'llama3.2:3b' },
  },
  {
    name: 'a cloud provider change',
    write: (w) =>
      w.configuration.setInferenceCloudProviders([{ provider: 'anthropic', apiKey: 'sk-ant', defaultModel: 'claude-sonnet', enabled: true }]),
    writes: { inferenceCloudProviders: [{ provider: 'anthropic', apiKey: 'sk-ant', defaultModel: 'claude-sonnet', enabled: true }] },
  },
  {
    name: 'a pool tuning save',
    write: (w) => w.configuration.setHubPoolPreferences({ poolLocalAffinity: 7 }),
    writes: { hubPoolLocalAffinity: 7 },
  },
  {
    name: 'a pool pin change',
    write: (w) => w.configuration.setHubPoolPreferences({ poolPins: [] }),
    writes: { hubPoolPins: [] },
  },
  {
    name: 'the Portal pairing callback',
    write: (w) => w.configuration.setUserSettings({ ciHubApiKey: 'rotated-portal-key' }),
    writes: { ciHubApiKey: 'rotated-portal-key' },
  },
  {
    name: 'the Portal pairing, keeping the move key it returned',
    write: (w) => w.configuration.setUserSettings({ ciHubMoveKey: 'rotated-move-key' }),
    writes: { ciHubMoveKey: 'rotated-move-key' },
  },
  { name: 'the auto-update switch', write: (w) => w.systemUpdate.setAutoUpdatesEnabled(true), writes: { autoUpdates: true } },
];

describe('settings.json round trip', () => {
  it('has a fixture value for every key settings.json can hold, and every one of them parses unchanged', () => {
    // Without this, a key added to the schema but not to ONE_OF_EVERY_KEY would never be exercised
    // by the writes below, and a fixture value the schema rejects would show up as a confusing drop.
    expect(Object.keys(ONE_OF_EVERY_KEY).sort()).toEqual(Object.keys(settingsFileSchema.shape).sort());

    const parsed = parsePersistedSettings(ONE_OF_EVERY_KEY);
    expect(parsed.invalidKeys).toEqual([]);
    expect(parsed.settings).toEqual(ONE_OF_EVERY_KEY);
  });

  it.each(WRITERS)('MUST NOT drop or change any other key when $name rewrites the file', async ({ write, writes }) => {
    await fs.promises.writeFile(SETTINGS_PATH, JSON.stringify(ONE_OF_EVERY_KEY, null, 2));

    await write(makeWriters());

    const written = JSON.parse(await fs.promises.readFile(SETTINGS_PATH, 'utf8')) as Record<string, unknown>;
    expect(written).toMatchObject(writes);
    const lost = Object.keys(ONE_OF_EVERY_KEY).filter(
      (key) => !(key in writes) && !isDeepStrictEqual(written[key], ONE_OF_EVERY_KEY[key as keyof PersistedSettings]),
    );
    expect(lost).toEqual([]);
  });

  it('MUST keep auto-update off through an unrelated write (fleet 2026-09-17)', async () => {
    const writers = makeWriters();
    await fs.promises.writeFile(SETTINGS_PATH, '{}');

    await writers.systemUpdate.setAutoUpdatesEnabled(false);
    await writers.configuration.setUserSettings({ allowErrorMonitoring: false });

    expect(writers.systemUpdate.getAutoUpdatesEnabled()).toBe(false);
  });

  it('MUST NOT erase the Portal credential, or log its text, when the auto-update switch meets a file it cannot parse', async () => {
    // The switch's old private writer answered an unparseable file by writing back only
    // `{"autoUpdates": ...}`, which erased `ciHubApiKey` and left the Hub looking unregistered. An
    // unquoted value is the usual hand-edit mistake, and V8's parse error quotes the text around it.
    const handEdited = '{"ciHubOrganizationId": "org-1", "ciHubApiKey": sk-live-0123456789abcdef}';
    await fs.promises.writeFile(SETTINGS_PATH, handEdited);
    const writers = makeWriters();

    const failure = await writers.systemUpdate.setAutoUpdatesEnabled(false).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(InternalServerErrorException);
    expect(await fs.promises.readFile(SETTINGS_PATH, 'utf8')).toBe(handEdited);
    expect(String((failure as Error).message)).not.toContain('sk-live');
    expect(writers.logger.error).toHaveBeenCalledWith(expect.stringContaining('attemptedKeys=autoUpdates'));
    expect(logged(writers.logger)).not.toContain('sk-live');
  });

  it('drops a key this build does not declare, and names it without its value', async () => {
    // Deliberate: `mcpAllowDestructive` is a retired appliance-wide gate, and carrying a stale value
    // forward is what the strip exists to prevent. The same strip removes a key that a newer build
    // wrote before a node went back to an older one, so it has to say so in the log.
    await fs.promises.writeFile(SETTINGS_PATH, JSON.stringify({ ...ONE_OF_EVERY_KEY, mcpAllowDestructive: 'retired-gate-value' }));
    const writers = makeWriters();

    await writers.configuration.setUserSettings({ themeColor: 'blue' });

    const written = JSON.parse(await fs.promises.readFile(SETTINGS_PATH, 'utf8')) as Record<string, unknown>;
    expect(written).not.toHaveProperty('mcpAllowDestructive');
    expect(writers.logger.warn).toHaveBeenCalledWith(expect.stringContaining('mcpAllowDestructive'));
    expect(logged(writers.logger)).not.toContain('retired-gate-value');
  });
});

describe('settings.json access outside the shared merge', () => {
  // The round trip above only covers writers it knows about. `autoUpdates` was dropped because its
  // writer was a private read-modify-write in another module, which no schema or type check could
  // see. So any new file that opens settings.json, or writes it, fails here until someone has
  // checked that the keys it touches are declared in `settingsFileSchema` and added it below.
  const SRC = path.join(__dirname, '..', '..', '..');

  /** Files allowed to name the settings.json path, and why each one is safe. */
  const MAY_OPEN = {
    'common/helpers/env-helpers.ts': 'the file primitives, and the boot read, which goes through parsePersistedSettings',
    'core/config/configuration.service.ts': 'the shared merge, and the Nest-side read through parsePersistedSettings',
    'core/error-reporting/telemetry-consent.ts': 'reads allowErrorMonitoring, a declared key, where Nest may not exist',
    'modules/system/factory-reset.service.ts': 'writes {}, which holds no key to drop',
    'modules/system-update/system-update.service.ts': 'reads autoUpdates, a declared key; writes through setFileOnlySettings',
  };

  /** Files allowed to call writeSettingsJsonFile. Every key write belongs in mergeSettingsToDisk. */
  const MAY_WRITE = {
    'common/helpers/env-helpers.ts': 'defines it',
    'core/config/configuration.service.ts': 'mergeSettingsToDisk',
    'modules/system/factory-reset.service.ts': 'writes {}',
  };

  async function sourceFiles(): Promise<Array<{ file: string; code: string }>> {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const entries = realFs.readdirSync(SRC, { recursive: true, encoding: 'utf8' });
    return entries
      .map((entry) => entry.split(path.sep).join('/'))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.includes('__tests__/') && !file.startsWith('tests/'))
      .map((file) => ({ file, code: realFs.readFileSync(path.join(SRC, file), 'utf8') }));
  }

  it('MUST NOT open settings.json from a file that has not been checked against the schema', async () => {
    const opening = (await sourceFiles()).filter(({ code }) => /['"]settings\.json['"]/.test(code)).map(({ file }) => file);

    // Exact, not a subset: a scan that silently matched nothing would otherwise pass forever.
    expect(opening.sort()).toEqual(Object.keys(MAY_OPEN).sort());
  });

  it('MUST NOT write settings.json anywhere but the shared merge', async () => {
    const writing = (await sourceFiles()).filter(({ code }) => /\bwriteSettingsJsonFile\(/.test(code)).map(({ file }) => file);

    expect(writing.sort()).toEqual(Object.keys(MAY_WRITE).sort());
  });
});
