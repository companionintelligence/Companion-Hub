import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { AppUrn } from '@ci-hub/common/types';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { InferenceEnvStaleness } from '@/modules/apps/inference-env-staleness.service';

// The lifecycle service drags in the queue, Docker and Portal graphs; this suite only needs the
// one method the refresh calls, so the module is replaced with an empty class and mocked per test.
vi.mock('../app-lifecycle.service', () => ({ AppLifecycleService: class AppLifecycleService {} }));
vi.mock('@/modules/apps/inference-env-staleness.service', () => ({ InferenceEnvStalenessService: class InferenceEnvStalenessService {} }));

import { AppLifecycleService } from '../app-lifecycle.service';
import { InferenceEnvStalenessService } from '@/modules/apps/inference-env-staleness.service';
import { AppCredentialsService } from '@/modules/inference/app-credentials.service';
import { InferenceEndpointService } from '@/modules/inference/inference-endpoint.service';
import {
  AUTOMATIC_RESTART_COOLDOWN_MS,
  AiAppInferenceRefreshService,
  changedInferenceEnvSettings,
  MEMBERSHIP_SETTLE_POLLS,
  REFRESH_DEBOUNCE_MS,
} from '../ai-app-inference-refresh.service';

const HERMES = 'hermes-agent:ci-marketplace' as AppUrn;
const OPENCLAW = 'openclaw:ci-marketplace' as AppUrn;
const MEMORY = 'ci-memory:ci-marketplace' as AppUrn;

const staleness = (appUrn: AppUrn, overrides: Partial<InferenceEnvStaleness>): InferenceEnvStaleness => ({
  appUrn,
  aiApp: true,
  stale: false,
  basis: ['app-env'],
  differences: [],
  reasons: [],
  generated: null,
  current: null,
  wouldRemoveEndpoint: false,
  wouldRemoveChatModel: false,
  checkedAt: '2026-09-17T10:00:00.000Z',
  ...overrides,
});

describe('AiAppInferenceRefreshService', () => {
  let service: AiAppInferenceRefreshService;
  let lifecycle: MockProxy<AppLifecycleService>;
  let stalenessService: MockProxy<InferenceEnvStalenessService>;
  let credentials: MockProxy<AppCredentialsService>;
  let endpoints: MockProxy<InferenceEndpointService>;
  let restarted: AppUrn[];
  let results: Map<AppUrn, InferenceEnvStaleness | Error>;

  beforeEach(() => {
    lifecycle = mock<AppLifecycleService>();
    stalenessService = mock<InferenceEnvStalenessService>();
    credentials = mock<AppCredentialsService>();
    endpoints = mock<InferenceEndpointService>();
    const configuration = mock<ConfigurationService>();
    configuration.getHubPoolPreferences.mockReturnValue({ poolHealthPollSeconds: 30 } as never);

    restarted = [];
    results = new Map();
    // Stands in for restartAiApps' loop over running AI apps: ask, then restart on a yes.
    lifecycle.restartAiApps.mockImplementation(async (options) => {
      for (const appUrn of [HERMES, OPENCLAW, MEMORY]) {
        if (!options?.shouldRestart || (await options.shouldRestart(appUrn))) restarted.push(appUrn);
      }
    });
    stalenessService.check.mockImplementation(async (appUrn) => {
      const result = results.get(appUrn) ?? staleness(appUrn, {});
      if (result instanceof Error) throw result;
      return result;
    });

    service = new AiAppInferenceRefreshService(mock<LoggerService>(), lifecycle, stalenessService, credentials, endpoints, configuration);
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  describe('a sweep', () => {
    it('restarts only the apps whose inference env is stale, leaving Companion Memory running when its env did not change', async () => {
      results.set(HERMES, staleness(HERMES, { stale: true, reasons: ['chat model: gemma3:1b -> qwen3-coder:30b'] }));
      results.set(OPENCLAW, staleness(OPENCLAW, { stale: true, basis: ['app-env', 'bootstrap-handout'] }));

      service.requestRefresh('inference preferences changed');
      const decisions = await service.flush();

      expect(restarted).toEqual([HERMES, OPENCLAW]);
      expect(decisions.find((d) => d.appUrn === MEMORY)).toEqual({ appUrn: MEMORY, restart: false, why: 'its inference config is already current' });
      expect(lifecycle.restartAiApps).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'inference preferences changed' }));
    });

    it('drops the credentials cache the moment a refresh is requested, not when the debounced sweep runs', () => {
      service.requestRefresh('settings changed: inferenceModel');

      expect(credentials.invalidateCache).toHaveBeenCalledTimes(1);
      expect(lifecycle.restartAiApps).not.toHaveBeenCalled();
    });

    it('collapses a burst of writes into one sweep', async () => {
      vi.useFakeTimers();
      results.set(HERMES, staleness(HERMES, { stale: true }));

      service.requestRefresh('cloud provider openai changed');
      service.requestRefresh('cloud provider anthropic changed');
      service.requestRefresh('inference preferences changed');
      await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);

      expect(lifecycle.restartAiApps).toHaveBeenCalledTimes(1);
      expect(restarted).toEqual([HERMES]);
    });

    it('does not restart automatically when regenerating would remove an app endpoint, but does when an operator asked', async () => {
      results.set(HERMES, staleness(HERMES, { stale: true, wouldRemoveEndpoint: true, reasons: ['routing: pool -> direct'] }));

      service.requestRefresh('pool membership changed', { automatic: true });
      await service.flush();
      expect(restarted).toEqual([]);

      service.requestRefresh('inference preferences changed');
      await service.flush();
      expect(restarted).toEqual([HERMES]);
    });

    it('does not restart automatically into a config with no chat model, but does when an operator asked', async () => {
      // A peer that served the only model an agent can use drops for two polls: restarting the agent
      // mid-turn to hand it nothing is worse than leaving it on a model that may be back next poll.
      results.set(OPENCLAW, staleness(OPENCLAW, { stale: true, wouldRemoveChatModel: true, reasons: ['chat model: qwen3-coder:30b -> none'] }));

      service.requestRefresh('pool membership changed', { automatic: true });
      const decisions = await service.flush();
      expect(restarted).toEqual([]);
      expect(decisions.find((d) => d.appUrn === OPENCLAW)?.why).toContain('would remove its chat model');

      service.requestRefresh('inference preferences changed');
      await service.flush();
      expect(restarted).toEqual([OPENCLAW]);
    });

    it('does not restart an app again automatically while a flapping peer keeps moving membership, and catches up when the cooldown ends', async () => {
      vi.useFakeTimers();
      results.set(OPENCLAW, staleness(OPENCLAW, { stale: true, reasons: ['routing: direct -> pool'] }));

      service.requestRefresh('pool membership changed: core-6 connected', { automatic: true });
      await service.flush();
      expect(restarted).toEqual([OPENCLAW]);

      // core-6 drops and returns four minutes later; OpenClaw is mid-turn on a 300 s prefill.
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      service.requestRefresh('pool membership changed: core-6 unreachable', { automatic: true });
      const held = await service.flush();
      expect(restarted).toEqual([OPENCLAW]);
      expect(held.find((d) => d.appUrn === OPENCLAW)?.why).toContain('checking again in 360 s');

      // An operator's change is never held back.
      service.requestRefresh('inference preferences changed');
      await service.flush();
      expect(restarted).toEqual([OPENCLAW, OPENCLAW]);

      // Still stale when the cooldown from that restart ends: the recheck picks it up without another event.
      await vi.advanceTimersByTimeAsync(AUTOMATIC_RESTART_COOLDOWN_MS + REFRESH_DEBOUNCE_MS);
      expect(restarted).toEqual([OPENCLAW, OPENCLAW, OPENCLAW]);
    });

    it('restarts on a failed staleness check only when an operator changed a setting', async () => {
      results.set(HERMES, new Error('app.env unreadable'));

      service.requestRefresh('pool membership changed', { automatic: true });
      await service.flush();
      expect(restarted).toEqual([]);

      service.requestRefresh('settings changed: inferenceModel');
      await service.flush();
      expect(restarted).toEqual([HERMES]);
    });
  });

  describe('pool membership watcher', () => {
    const membership = (signature: string | null, description = signature ?? 'unreadable') => ({ signature, description });

    it('takes the first reading as a baseline and restarts nothing for it', async () => {
      endpoints.poolMembership.mockResolvedValue(membership('direct'));

      await service.observePoolMembership();
      await service.observePoolMembership();

      expect(credentials.invalidateCache).not.toHaveBeenCalled();
    });

    it('requests an automatic refresh once a new membership has held for the settle window', async () => {
      const requested = vi.spyOn(service, 'requestRefresh');
      endpoints.poolMembership.mockResolvedValueOnce(membership('direct', 'no connected pool peers'));
      await service.observePoolMembership();

      endpoints.poolMembership.mockResolvedValue(membership('pool;outbound=true;peers=id-core-6', 'routing through the pool with core-6'));
      for (let poll = 1; poll < MEMBERSHIP_SETTLE_POLLS; poll++) {
        await service.observePoolMembership();
        expect(requested).not.toHaveBeenCalled();
      }
      await service.observePoolMembership();

      expect(requested).toHaveBeenCalledTimes(1);
      expect(requested).toHaveBeenCalledWith('pool membership changed: no connected pool peers -> routing through the pool with core-6', {
        automatic: true,
      });

      // Holding steady afterwards is not another change.
      await service.observePoolMembership();
      expect(requested).toHaveBeenCalledTimes(1);
    });

    it('ignores a one-poll flicker and an unreadable peer table', async () => {
      const requested = vi.spyOn(service, 'requestRefresh');
      endpoints.poolMembership.mockResolvedValueOnce(membership('pool;outbound=true;peers=id-core-6'));
      await service.observePoolMembership();

      endpoints.poolMembership.mockResolvedValueOnce(membership('direct'));
      await service.observePoolMembership();
      endpoints.poolMembership.mockResolvedValueOnce(membership(null));
      await service.observePoolMembership();
      endpoints.poolMembership.mockResolvedValueOnce(membership('pool;outbound=true;peers=id-core-6'));
      await service.observePoolMembership();
      endpoints.poolMembership.mockResolvedValueOnce(membership('direct'));
      await service.observePoolMembership();

      expect(requested).not.toHaveBeenCalled();
    });
  });

  describe('changedInferenceEnvSettings', () => {
    it('names the inference and pool-routing keys a settings write changes, and nothing else', () => {
      expect(changedInferenceEnvSettings({}, { inferenceModel: 'qwen3-coder-30b', themeColor: 'blue', hubPoolEnabled: false })).toEqual([
        'inferenceModel',
        'hubPoolEnabled',
      ]);
      expect(changedInferenceEnvSettings({}, { themeColor: 'blue', hubPoolLocalAffinity: 1 })).toEqual([]);
    });

    it('ignores inference keys a write carries with the values they already had', () => {
      // The General settings form submits everything it was loaded with, inference keys included.
      const stored = {
        inferenceModel: 'qwen3-coder-30b',
        inferenceCloudProviders: [{ provider: 'openai', apiKey: 'sk-x', enabled: true }],
        hubPoolEnabled: true,
      };

      expect(changedInferenceEnvSettings(stored, { ...structuredClone(stored), timeZone: 'Europe/Berlin' })).toEqual([]);
      expect(changedInferenceEnvSettings({}, { inferenceVllmUrl: null })).toEqual([]);
      expect(changedInferenceEnvSettings(stored, { ...stored, inferenceCloudProviders: [] })).toEqual(['inferenceCloudProviders']);
    });
  });
});
