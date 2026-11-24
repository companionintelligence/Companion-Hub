import { describe, expect, it } from 'vitest';
import { formatOllamaKvCacheResultLines, type InferencePreferencesResponse } from '../hub-pool-cli';
import { parseOllamaKvCacheArg } from '../lib/cli-pool';

// `cihub pool kv-cache`: the Hub's half of OLLAMA_KV_CACHE_TYPE, which Ollama's API does not expose.
describe('parseOllamaKvCacheArg', () => {
  it('takes the three cache types and clear, and nothing else', () => {
    expect(parseOllamaKvCacheArg('q8_0')).toBe('q8_0');
    expect(parseOllamaKvCacheArg(' Q4_0 ')).toBe('q4_0');
    expect(parseOllamaKvCacheArg('f16')).toBe('f16');
    expect(parseOllamaKvCacheArg('clear')).toBeNull();
    expect(parseOllamaKvCacheArg('q5_1')).toBeUndefined();
    expect(parseOllamaKvCacheArg('8')).toBeUndefined();
    expect(parseOllamaKvCacheArg(undefined)).toBeUndefined();
  });
});

describe('formatOllamaKvCacheResultLines', () => {
  const prefs = (ollamaKvCacheType: InferencePreferencesResponse['ollamaKvCacheType']): InferencePreferencesResponse => ({
    preferredBackend: 'ollama',
    ollamaKvCacheType,
  });

  it('refuses on a Hub that predates the setting', () => {
    expect(formatOllamaKvCacheResultLines('q8_0', { preferredBackend: 'ollama' }, null, false)).toMatchObject({
      tone: 'red',
      title: expect.stringContaining('not supported'),
    });
  });

  it('says nothing changed when it already reads as asked', () => {
    expect(formatOllamaKvCacheResultLines('q8_0', prefs('q8_0'), null, false)).toMatchObject({
      tone: 'cyan',
      title: expect.stringContaining('unchanged'),
    });
  });

  it('fails when the Hub reads back something else', () => {
    expect(formatOllamaKvCacheResultLines('q8_0', prefs(null), prefs(null), true)).toMatchObject({ tone: 'red' });
  });

  it('names the daemon settings to match on a set, flash attention with a quantized cache, and the 4-bit caveat', () => {
    const q8 = formatOllamaKvCacheResultLines('q8_0', prefs(null), prefs('q8_0'), true);
    expect(q8.tone).toBe('green');
    expect(q8.lines.join('\n')).toContain('OLLAMA_KV_CACHE_TYPE=q8_0 and OLLAMA_FLASH_ATTENTION=1');
    expect(q8.lines.join('\n')).toContain('cihub fleet backends --ollama-kv-cache q8_0');
    expect(q8.lines.join('\n')).not.toContain('4-bit can change');
    expect(formatOllamaKvCacheResultLines('q4_0', prefs(null), prefs('q4_0'), true).lines.join('\n')).toContain('4-bit can change');
    expect(formatOllamaKvCacheResultLines('f16', prefs('q8_0'), prefs('f16'), true).lines.join('\n')).not.toContain('FLASH_ATTENTION');
  });

  it('says a clear sizes for 16-bit again', () => {
    expect(formatOllamaKvCacheResultLines(null, prefs('q8_0'), prefs(null), true)).toMatchObject({
      tone: 'yellow',
      title: expect.stringContaining('cleared'),
    });
  });
});
