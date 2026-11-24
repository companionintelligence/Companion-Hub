import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');

/**
 * Which model list OpenClaw's entrypoint syncs for the engine the Hub has active.
 *
 * vLLM and oMLX are OpenAI servers, so their models come from `/v1/models`; the `*)` arm syncs
 * Ollama's native list, which is wrong for an engine that is not Ollama. The arm kept naming the
 * retired `dspark` after the engine consolidation, so an oMLX Hub synced from Ollama.
 */
const ENTRYPOINT = path.join(__dirname, '../data/openclaw-ci-entrypoint.sh');

/** Runs `sync_inference_models` from the real script with the backend lookup and the two syncs stubbed. */
function syncedFor(backend: string): string {
  const script = readFileSync(ENTRYPOINT, 'utf-8');
  const fn = script.match(/^sync_inference_models\(\) \{\n[\s\S]*?\n\}\n/m)?.[0];
  expect(fn, 'sync_inference_models in the entrypoint').toBeDefined();
  const stubs = [
    `resolve_inference_backend() { printf '%s' '${backend}'; }`,
    'sync_vllm_models() { echo openai-v1-sync; }',
    'sync_ollama_models() { echo ollama-native-sync; }',
  ].join('\n');
  const result = spawnSync('sh', ['-c', `${stubs}\n${fn}\nsync_inference_models`], { encoding: 'utf-8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe('OpenClaw entrypoint model sync', () => {
  it.each([
    ['vllm', 'openai-v1-sync'],
    ['omlx', 'openai-v1-sync'],
    ['ollama', 'ollama-native-sync'],
  ])('syncs a %s Hub with %s', (backend, expected) => {
    expect(syncedFor(backend)).toBe(expected);
  });

  it('syncs no local list while cloud inference is primary', () => {
    const out = syncedFor('cloud');
    expect(out).toContain('cloud inference selected as primary');
    expect(out).not.toContain('sync');
  });

  it('no longer names the retired runners', () => {
    expect(readFileSync(ENTRYPOINT, 'utf-8')).not.toMatch(/dspark|mtplx/i);
  });
});
