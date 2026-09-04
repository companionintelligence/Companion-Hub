import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  automaticRunnersForBackend,
  DEFAULT_AUTOMATIC_INFERENCE_RUNNERS,
  DEFAULT_MACOS_AUTOMATIC_INFERENCE_RUNNERS,
  DEFAULT_MACOS_MTPLX_AUTOMATIC_INFERENCE_RUNNERS,
  installAndStartInferenceRunners,
} from './auto-inference-runners';

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
};

afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
});

describe('installAndStartInferenceRunners', () => {
  it('keeps the Apple Silicon FTUE set focused on mlx-dspark and Ollama', () => {
    expect(DEFAULT_MACOS_AUTOMATIC_INFERENCE_RUNNERS).toEqual(['dspark', 'ollama']);
  });

  it('keeps the MTPLX alternative focused on MTPLX and Ollama', () => {
    expect(DEFAULT_MACOS_MTPLX_AUTOMATIC_INFERENCE_RUNNERS).toEqual(['mtplx', 'ollama']);
    expect(automaticRunnersForBackend('mtplx')).toEqual(['mtplx', 'ollama']);
    expect(automaticRunnersForBackend('dspark')).toEqual(['dspark', 'ollama']);
  });

  it('uses the complete set for non-Apple-specific backends', () => {
    expect(automaticRunnersForBackend('vllm')).toEqual(DEFAULT_AUTOMATIC_INFERENCE_RUNNERS);
  });

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
