import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  automaticRunnersForBackend,
  DEFAULT_AUTOMATIC_INFERENCE_RUNNERS,
  DEFAULT_MACOS_AUTOMATIC_INFERENCE_RUNNERS,
  installAndStartInferenceRunners,
} from './auto-inference-runners';

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
};

afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
});

describe('installAndStartInferenceRunners', () => {
  it('keeps the Apple Silicon set on oMLX', () => {
    expect(DEFAULT_MACOS_AUTOMATIC_INFERENCE_RUNNERS).toEqual(['omlx']);
    expect(automaticRunnersForBackend('omlx')).toEqual(['omlx']);
  });

  it('installs vLLM with Ollama for embeddings, and Ollama alone for Lemonade', () => {
    expect(automaticRunnersForBackend('vllm')).toEqual(['vllm', 'ollama']);
    expect(automaticRunnersForBackend('ollama')).toEqual(['ollama']);
    expect(automaticRunnersForBackend('lemonade')).toEqual(['ollama']);
  });

  it('falls back to Ollama for an unknown backend', () => {
    expect(automaticRunnersForBackend('future-backend')).toEqual(DEFAULT_AUTOMATIC_INFERENCE_RUNNERS);
  });

  it('is a no-op in a browser build', async () => {
    await expect(installAndStartInferenceRunners()).resolves.toEqual([]);
  });

  it('passes the automatic runner set to the desktop command', async () => {
    const invoke = vi.fn().mockResolvedValue([{ runner: 'ollama', state: 'installed_and_started' }]);
    (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };

    await expect(installAndStartInferenceRunners()).resolves.toEqual([{ runner: 'ollama', state: 'installed_and_started' }]);
    expect(invoke).toHaveBeenCalledWith('install_and_start_inference_runners_command', {
      backends: DEFAULT_AUTOMATIC_INFERENCE_RUNNERS,
    });
  });
});
