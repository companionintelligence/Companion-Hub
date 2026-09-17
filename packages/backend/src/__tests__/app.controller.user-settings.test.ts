import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

vi.mock('@/modules/app-lifecycle/app-lifecycle.service', () => ({ AppLifecycleService: class AppLifecycleService {} }));

import { AppController } from '../app.controller';
import type { AiAppInferenceRefreshService } from '../modules/app-lifecycle/ai-app-inference-refresh.service';
import type { ConfigurationService } from '@/core/config/configuration.service';

describe('PATCH /api/user-settings — inference preferences', () => {
  let controller: AppController;
  let configuration: ReturnType<typeof mock<ConfigurationService>>;
  let refresh: ReturnType<typeof mock<AiAppInferenceRefreshService>>;

  beforeEach(() => {
    configuration = mock<ConfigurationService>();
    refresh = mock<AiAppInferenceRefreshService>();
    // Only the two collaborators this route touches matter; the rest are inert stand-ins.
    const unused = () => mock<never>();
    controller = new AppController(unused(), unused(), configuration, unused(), unused(), unused(), unused(), unused(), unused(), unused(), refresh);
  });

  it('refreshes AI apps through the same service as PATCH /api/inference/preferences when a preference changes', async () => {
    // The two routes wrote the same settings.json keys; only the inference route ever refreshed apps.
    await controller.updateUserSettings({ inferenceModel: 'qwen3-coder-30b', themeColor: 'blue' } as never);

    expect(configuration.setUserSettings).toHaveBeenCalledWith({ inferenceModel: 'qwen3-coder-30b', themeColor: 'blue' });
    expect(refresh.requestRefresh).toHaveBeenCalledWith('settings changed: inferenceModel');
  });

  it('refreshes when the pool is switched off, since that repoints every pooled app', async () => {
    await controller.updateUserSettings({ hubPoolEnabled: false } as never);

    expect(refresh.requestRefresh).toHaveBeenCalledWith('settings changed: hubPoolEnabled');
  });

  it('leaves AI apps alone when the General settings form resubmits the inference values it was loaded with', async () => {
    // That form is loaded from userSettings and posts every value back, so a time-zone save carries inferenceModel.
    configuration.get.mockReturnValue({ inferenceModel: 'qwen3-coder-30b', hubPoolEnabled: true } as never);

    await controller.updateUserSettings({ inferenceModel: 'qwen3-coder-30b', hubPoolEnabled: true, timeZone: 'Europe/Berlin' } as never);

    expect(configuration.setUserSettings).toHaveBeenCalled();
    expect(refresh.requestRefresh).not.toHaveBeenCalled();
  });

  it('leaves AI apps alone for a write that touches no inference setting', async () => {
    await controller.updateUserSettings({ themeColor: 'blue', allowAutoThemes: false } as never);

    expect(refresh.requestRefresh).not.toHaveBeenCalled();
  });

  it('does not refresh when the write itself fails', async () => {
    configuration.setUserSettings.mockRejectedValue(new Error('Failed to set user settings'));

    await expect(controller.updateUserSettings({ inferenceModel: 'qwen3-coder-30b' } as never)).rejects.toThrow('Failed to set user settings');
    expect(refresh.requestRefresh).not.toHaveBeenCalled();
  });
});
