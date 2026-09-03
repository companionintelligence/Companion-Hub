import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTOMATIC_INFERENCE_RUNNERS, installAndStartInferenceRunners } from './auto-inference-runners';

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
};

afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
});

describe('installAndStartInferenceRunners', () => {
  it('is a no-op in a browser build', async () => {
    await expect(installAndStartInferenceRunners()).resolves.toEqual([]);
  });

  it('passes the complete automatic runner set to the desktop command', async () => {
    const invoke = vi.fn().mockResolvedValue([{ runner: 'dspark', state: 'installed_and_started' }]);
    (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };

    await expect(installAndStartInferenceRunners()).resolves.toEqual([{ runner: 'dspark', state: 'installed_and_started' }]);
    expect(invoke).toHaveBeenCalledWith('install_and_start_inference_runners_command', {
      backends: DEFAULT_AUTOMATIC_INFERENCE_RUNNERS,
    });
  });
});
