import { describe, expect, it } from 'vitest';
import {
  type CheckRow,
  contextLimit,
  FILE_TYPE_EXCEPTIONS,
  type Finding,
  judgeHfGgufRow,
  judgeHfRepoRow,
  judgeOllamaRow,
  rootWeightBytes,
  statusOf,
} from '../catalog/row-checks';
import type { HfModel, HfRepoRead, OllamaConfig, OllamaManifest, Read } from '../catalog/row-reads';
import { fixtureJson } from './fixtures/catalog-rows/replay';

/**
 * Every rule of the row checker against answers recorded from the real registries (fixtures/catalog-rows/README.md says how),
 * so the rules are tested against what the registries say rather than against what this file imagines they say.
 */

const PIN = '0.34.0';

const row = (over: Partial<CheckRow>): CheckRow => ({
  id: 'row',
  backend: 'ollama',
  backendModelId: 'row:1b',
  quant: 'q4_K_M',
  gb: 1,
  contextWindow: 131072,
  gpuVendors: ['nvidia', 'amd', 'apple', 'cpu'],
  ...over,
});

const ollamaRead = (slug: string, tweak?: (config: OllamaConfig) => void): Read<{ manifest: OllamaManifest; config: OllamaConfig }> => {
  const config = fixtureJson<OllamaConfig>(`ollama/${slug}.config.json`);
  tweak?.(config);
  return { ok: true, value: { manifest: fixtureJson<OllamaManifest>(`ollama/${slug}.manifest.json`), config } };
};

const codes = (verdict: { findings: { code: string }[] }): string[] => verdict.findings.map((f) => f.code);

describe('Ollama registry rows', () => {
  // qwen3.6:27b: model + projector + license + params = 17,769,076,719 bytes, Q4_K_M, requires 0.30.0.
  const qwen = row({ id: 'qwen3-6-27b', backendModelId: 'qwen3.6:27b', gb: 17, fileBytes: 17_769_076_719 });

  it('passes a row whose layers, size, quant label and Ollama version all agree, and says what it read', () => {
    const verdict = judgeOllamaRow(qwen, ollamaRead('qwen3.6-27b'), PIN);
    expect(verdict.findings).toEqual([]);
    expect(verdict.facts).toEqual(['Q4_K_M', '17.77 GB', 'requires 0.30.0']);
  });

  it('reports a registry that no longer matches the generated table, with both sizes and the command that fixes it', () => {
    const verdict = judgeOllamaRow({ ...qwen, fileBytes: 17_630_000_000 }, ollamaRead('qwen3.6-27b'), PIN);
    expect(codes(verdict)).toEqual(['size-drift']);
    expect(verdict.findings[0]?.level).toBe('warn');
    expect(verdict.findings[0]?.message).toContain('17,769,076,719 B');
    expect(verdict.findings[0]?.message).toContain('17,630,000,000 B');
    expect(verdict.findings[0]?.message).toContain('gen-kv-geometry.ts --only qwen3-6-27b');
  });

  it('means equal by equal: a table one byte off is a table that has drifted', () => {
    expect(codes(judgeOllamaRow({ ...qwen, fileBytes: 17_769_076_718 }, ollamaRead('qwen3.6-27b'), PIN))).toEqual(['size-drift']);
    expect(codes(judgeOllamaRow({ ...qwen, fileBytes: 17_769_076_719 }, ollamaRead('qwen3.6-27b'), PIN))).toEqual([]);
  });

  it('reports a row the generated table has no entry for', () => {
    expect(codes(judgeOllamaRow({ ...qwen, fileBytes: undefined }, ollamaRead('qwen3.6-27b'), PIN))).toEqual(['no-geometry']);
  });

  it('accepts a gb within 10% of the layers and reports one beyond it, in decimal GB', () => {
    // The layers total 17.769 GB: 16.2 is +9.7% off, 16.1 is +10.4% off.
    expect(codes(judgeOllamaRow({ ...qwen, gb: 16.2 }, ollamaRead('qwen3.6-27b'), PIN))).toEqual([]);
    const off = judgeOllamaRow({ ...qwen, gb: 16.1 }, ollamaRead('qwen3.6-27b'), PIN);
    expect(codes(off)).toEqual(['size-gb']);
    expect(off.findings[0]?.message).toContain('+10.4%');
    // And from below: 12 is +48.1% off, and 19.5 is -8.9% off.
    expect(judgeOllamaRow({ ...qwen, gb: 12 }, ollamaRead('qwen3.6-27b'), PIN).findings[0]?.message).toContain('+48.1%');
    expect(codes(judgeOllamaRow({ ...qwen, gb: 19.5 }, ollamaRead('qwen3.6-27b'), PIN))).toEqual([]);
    expect(codes(judgeOllamaRow({ ...qwen, gb: 20 }, ollamaRead('qwen3.6-27b'), PIN))).toEqual(['size-gb']);
  });

  describe('file_type against the quant label', () => {
    // flint:40b ships NVFP4 under its default tag and requires Ollama 0.40.9.
    const flint = row({ id: 'flint-40b', backendModelId: 'flint:40b', gb: 23, fileBytes: 22_863_095_573 });

    it('reports an NVFP4 build under a q4_K_M label, and that the row is not gated to NVIDIA', () => {
      const verdict = judgeOllamaRow(flint, ollamaRead('flint-40b'), PIN);
      const quant = verdict.findings.find((f) => f.code === 'quant');
      expect(quant?.level).toBe('warn');
      expect(quant?.message).toContain('NVFP4');
      expect(quant?.message).toContain('q4_K_M');
      expect(quant?.message).toContain('does not gate it to NVIDIA');
    });

    it('does not say the row is ungated when it is gated to NVIDIA', () => {
      const verdict = judgeOllamaRow({ ...flint, gpuVendors: ['nvidia'] }, ollamaRead('flint-40b'), PIN);
      expect(verdict.findings.find((f) => f.code === 'quant')?.message).not.toContain('gate');
    });

    it('accepts the known exceptions, naming them, and nothing else', () => {
      expect(FILE_TYPE_EXCEPTIONS).toEqual({ 'gpt-oss-20b': 'MXFP4', 'gpt-oss-120b': 'MXFP4', 'gemma3-270m': 'Q8_0' });
      const gptOss = judgeOllamaRow(
        row({ id: 'gpt-oss-20b', backendModelId: 'gpt-oss:20b', gb: 14, fileBytes: 13_793_441_427 }),
        ollamaRead('gpt-oss-20b'),
        PIN,
      );
      expect(gptOss.findings).toEqual([]);
      expect(gptOss.facts[0]).toBe('MXFP4 (a known exception to q4_K_M)');
      const gemma = judgeOllamaRow(
        row({ id: 'gemma3-270m', backendModelId: 'gemma3:270m', gb: 0.3, fileBytes: 291_554_440 }),
        ollamaRead('gemma3-270m'),
        PIN,
      );
      expect(gemma.findings).toEqual([]);
    });

    it('does not extend an exception to another row, so the same MXFP4 build under another id is a finding', () => {
      const verdict = judgeOllamaRow(
        row({ id: 'some-other-row', backendModelId: 'gpt-oss:20b', gb: 14, fileBytes: 13_793_441_427 }),
        ollamaRead('gpt-oss-20b'),
        PIN,
      );
      expect(codes(verdict)).toEqual(['quant']);
    });

    it('still reports an exception row whose build changed, and names the exception', () => {
      const verdict = judgeOllamaRow(
        row({ id: 'gemma3-270m', backendModelId: 'gemma3:270m', gb: 0.3, fileBytes: 291_554_440 }),
        ollamaRead('gemma3-270m', (config) => {
          config.file_type = 'Q4_K_M';
        }),
        PIN,
      );
      expect(codes(verdict)).toEqual(['quant']);
      expect(verdict.findings[0]?.message).toContain('the known exception for this row is Q8_0');
    });

    it('compares without regard to case, as the registry says Q4_K_M and the catalog q4_K_M', () => {
      expect(codes(judgeOllamaRow(qwen, ollamaRead('qwen3.6-27b'), PIN))).toEqual([]);
    });

    it('reports a config that states no file_type, because the label is then unchecked', () => {
      const verdict = judgeOllamaRow(
        qwen,
        ollamaRead('qwen3.6-27b', (config) => {
          config.file_type = undefined;
        }),
        PIN,
      );
      expect(codes(verdict)).toEqual(['quant']);
      expect(verdict.findings[0]?.message).toContain('unchecked');
    });
  });

  describe('requires against the Ollama pin', () => {
    const flint = row({ id: 'flint-40b', backendModelId: 'flint:40b', gb: 23, fileBytes: 22_863_095_573, gpuVendors: ['nvidia'], quant: 'NVFP4' });

    it('reports a build that needs a newer Ollama than the pin, and what the registry does to an older client', () => {
      const verdict = judgeOllamaRow(flint, ollamaRead('flint-40b'), PIN);
      expect(codes(verdict)).toEqual(['requires']);
      expect(verdict.findings[0]?.message).toContain('0.40.9');
      expect(verdict.findings[0]?.message).toContain('HTTP 412');
    });

    it('passes a build at or below the pin', () => {
      expect(codes(judgeOllamaRow(flint, ollamaRead('flint-40b'), '0.40.9'))).toEqual([]);
      expect(codes(judgeOllamaRow(flint, ollamaRead('flint-40b'), '0.40.10'))).toEqual([]);
      expect(codes(judgeOllamaRow(flint, ollamaRead('flint-40b'), '0.40.8'))).toEqual(['requires']);
    });

    it('compares versions as numbers, so 0.40.16 is above 0.40.9', () => {
      const ripple = row({ id: 'ripple-preview-65b', backendModelId: 'ripple-preview:65b', gb: 38.8, fileBytes: 38_798_821_130 });
      expect(codes(judgeOllamaRow(ripple, ollamaRead('ripple-preview-65b'), '0.40.9'))).toEqual(['requires']);
      expect(codes(judgeOllamaRow(ripple, ollamaRead('ripple-preview-65b'), '0.40.16'))).toEqual([]);
    });
  });

  describe('cloud proxies', () => {
    const cloud = row({ id: 'glm-5-3-cloud', backendModelId: 'glm-5.3:cloud', gb: 1 });

    it('fails a manifest whose config names a remote host, and stops there', () => {
      const verdict = judgeOllamaRow(cloud, ollamaRead('glm-5.3-cloud'), PIN);
      expect(verdict.findings).toHaveLength(1);
      expect(verdict.findings[0]?.level).toBe('fail');
      expect(verdict.findings[0]?.code).toBe('cloud');
      expect(verdict.findings[0]?.message).toContain('remote_host https://ollama.com');
    });

    it('fails a config that names only a remote host, or only a remote model, whatever the tag says', () => {
      const local = row({ id: 'qwen3-6-27b', backendModelId: 'qwen3.6:27b', gb: 17, fileBytes: 17_769_076_719 });
      const host = judgeOllamaRow(
        local,
        ollamaRead('qwen3.6-27b', (config) => (config.remote_host = 'https://ollama.com')),
        PIN,
      );
      expect(host.findings.map((f) => f.code)).toEqual(['cloud']);
      expect(host.findings[0]?.message).toContain('remote_host https://ollama.com');
      const model = judgeOllamaRow(
        local,
        ollamaRead('qwen3.6-27b', (config) => (config.remote_model = 'qwen3.6')),
        PIN,
      );
      expect(model.findings.map((f) => f.code)).toEqual(['cloud']);
      expect(model.findings[0]?.message).toContain('remote_model qwen3.6');
    });

    it('fails a cloud tag even when the config carries no marker', () => {
      const bare: Read<{ manifest: OllamaManifest; config: OllamaConfig }> = { ok: true, value: { manifest: { layers: [] }, config: {} } };
      for (const backendModelId of ['kimi-k2:1t-cloud', 'glm-5.3:cloud']) {
        expect(codes(judgeOllamaRow({ ...cloud, backendModelId }, bare, PIN))).toEqual(['cloud']);
      }
    });

    it('does not mistake a model whose name merely contains "cloud" for a proxy', () => {
      expect(
        codes(
          judgeOllamaRow(
            { ...cloud, id: 'qwen3-6-27b', backendModelId: 'cloudy:27b', gb: 17, fileBytes: 17_769_076_719 },
            ollamaRead('qwen3.6-27b'),
            PIN,
          ),
        ),
      ).toEqual([]);
    });
  });

  describe('answers the rules cannot rely on', () => {
    it('does not read a layer with no size as a layer of zero bytes, which would read as a model that shrank', () => {
      const read = ollamaRead('qwen3.6-27b');
      if (read.ok) delete read.value.manifest.layers?.[1]?.size;
      const verdict = judgeOllamaRow(qwen, read, PIN);
      expect(verdict.findings.map((f) => [f.level, f.code])).toEqual([['unverified', 'unverified']]);
      expect(verdict.findings[0]?.message).toContain('states no size');
      expect(statusOf(verdict.findings)).toBe('unverified');
      expect(verdict.facts).toEqual(['Q4_K_M', 'requires 0.30.0']);
    });

    it('does not read a requires that is not a version string as no requirement', () => {
      const verdict = judgeOllamaRow(
        qwen,
        ollamaRead('qwen3.6-27b', (config) => ((config as Record<string, unknown>).requires = 0.4)),
        PIN,
      );
      expect(verdict.findings.map((f) => [f.level, f.code])).toEqual([['unverified', 'unverified']]);
      expect(verdict.findings[0]?.message).toContain('requires is 0.4');
    });

    it('reads a file_type that is not a string as no file_type, without failing on it', () => {
      const verdict = judgeOllamaRow(
        qwen,
        ollamaRead('qwen3.6-27b', (config) => ((config as Record<string, unknown>).file_type = 15)),
        PIN,
      );
      expect(codes(verdict)).toEqual(['quant']);
      expect(verdict.findings[0]?.message).toContain('states no file_type');
    });
  });

  it('fails a manifest with no model layer, because there is nothing to pull', () => {
    const noWeights: Read<{ manifest: OllamaManifest; config: OllamaConfig }> = {
      ok: true,
      value: { manifest: { layers: [{ mediaType: 'application/vnd.ollama.image.license', size: 11_357 }] }, config: { file_type: 'Q4_K_M' } },
    };
    const verdict = judgeOllamaRow(qwen, noWeights, PIN);
    expect(verdict.findings.map((f) => [f.level, f.code])).toEqual([['fail', 'unpullable']]);
  });

  describe('a registry that refuses', () => {
    it('fails a tag the registry does not know as missing, with the registry words', () => {
      const verdict = judgeOllamaRow(qwen, { ok: false, status: 404, message: 'manifest unknown' }, PIN);
      expect(verdict.findings.map((f) => [f.level, f.code])).toEqual([['fail', 'missing']]);
      expect(verdict.findings[0]?.message).toContain('HTTP 404: manifest unknown');
    });

    it('fails another refusal as unpullable, and does not call a 401 from Ollama a private repo', () => {
      const verdict = judgeOllamaRow(qwen, { ok: false, status: 401, message: 'unauthorized' }, PIN);
      expect(codes(verdict)).toEqual(['missing']);
      expect(verdict.findings[0]?.message).not.toContain('private');
      expect(codes(judgeOllamaRow(qwen, { ok: false, status: 412, message: 'newer version of Ollama required' }, PIN))).toEqual(['unpullable']);
    });
  });
});

describe('hf.co rows (Hugging Face GGUF through the Ollama endpoint)', () => {
  const arete = row({
    id: 'arete-27b',
    backendModelId: 'hf.co/bartowski/NousResearch_Arete-27B-GGUF:Q4_K_M',
    gb: 18.1,
    // 17,203,416,064 of weights plus a 927,607,104 vision projector.
    fileBytes: 18_131_023_168,
  });
  const manifest = (name: string): Read<OllamaManifest> => ({ ok: true, value: fixtureJson<OllamaManifest>(`hf-gguf/${name}.json`) });

  it('passes a single-file quant whose layers, projector included, match the generated table', () => {
    const verdict = judgeHfGgufRow(arete, manifest('arete-27b.manifest'));
    expect(verdict.findings).toEqual([]);
    expect(verdict.facts).toEqual(['Q4_K_M', '18.13 GB']);
  });

  it('reports a size that was taken without the vision projector, which is how Arete was first sized', () => {
    const verdict = judgeHfGgufRow({ ...arete, fileBytes: 17_203_416_064 }, manifest('arete-27b.manifest'));
    expect(codes(verdict)).toEqual(['size-drift']);
    expect(verdict.findings[0]?.message).toContain('18,131,023,168 B');
  });

  it('passes a model with no projector', () => {
    const nanbeige = row({
      id: 'nanbeige4-3-33b',
      backendModelId: 'hf.co/bartowski/Nanbeige_Nanbeige4.3-33B-GGUF:Q4_K_M',
      gb: 20.8,
      fileBytes: 20_788_825_484,
    });
    expect(judgeHfGgufRow(nanbeige, manifest('nanbeige-4.3-33b.manifest')).findings).toEqual([]);
  });

  it('fails a repo of sharded files, which Ollama cannot pull, and says why', () => {
    const glm = row({ id: 'glm-5-2', backendModelId: 'hf.co/unsloth/GLM-5.2-GGUF:UD-Q4_K_XL', gb: 467 });
    const refusal = fixtureJson<{ error: string }>('hf-gguf/glm-5.2-sharded.400.json');
    const verdict = judgeHfGgufRow(glm, { ok: false, status: 400, message: refusal.error });
    expect(verdict.findings.map((f) => [f.level, f.code])).toEqual([['fail', 'unpullable']]);
    expect(verdict.findings[0]?.message).toContain('sharded');
  });

  it('fails a quant the repo does not have as missing, not as sharded', () => {
    const refusal = fixtureJson<{ error: string }>('hf-gguf/invalid-quant.400.json');
    const verdict = judgeHfGgufRow(
      { ...arete, backendModelId: 'hf.co/bartowski/NousResearch_Arete-27B-GGUF:Q9_NOPE' },
      { ok: false, status: 400, message: refusal.error },
    );
    expect(verdict.findings.map((f) => [f.level, f.code])).toEqual([['fail', 'missing']]);
    expect(verdict.findings[0]?.message).toContain('Q9_NOPE');
  });

  it('fails a repo Hugging Face answers 401 for, noting that missing and private look alike', () => {
    const refusal = fixtureJson<{ error: string }>('hf-gguf/missing-repo.401.json');
    const verdict = judgeHfGgufRow(arete, { ok: false, status: 401, message: refusal.error });
    expect(verdict.findings.map((f) => [f.level, f.code])).toEqual([['fail', 'missing']]);
    expect(verdict.findings[0]?.message).toContain('look alike');
  });

  it('does not read a layer with no size as a layer of zero bytes', () => {
    const read = manifest('arete-27b.manifest');
    if (read.ok) delete read.value.layers?.[1]?.size;
    const verdict = judgeHfGgufRow(arete, read);
    expect(verdict.findings.map((f) => [f.level, f.code])).toEqual([['unverified', 'unverified']]);
    expect(verdict.facts).toEqual(['Q4_K_M']);
  });

  it('holds a row with a known exception to the quant it is known to pull, by its tag', () => {
    const unsloth = { ...arete, backendModelId: 'hf.co/bartowski/NousResearch_Arete-27B-GGUF:UD-Q4_K_XL' };
    expect(codes(judgeHfGgufRow(unsloth, manifest('arete-27b.manifest')))).toEqual(['quant']);
    const accepted = judgeHfGgufRow(unsloth, manifest('arete-27b.manifest'), { 'arete-27b': 'UD-Q4_K_XL' });
    expect(accepted.findings).toEqual([]);
    expect(accepted.facts[0]).toBe('UD-Q4_K_XL (a known exception to q4_K_M)');
    const changed = judgeHfGgufRow(
      { ...unsloth, backendModelId: unsloth.backendModelId.replace('UD-Q4_K_XL', 'Q4_K_M') },
      manifest('arete-27b.manifest'),
      { 'arete-27b': 'UD-Q4_K_XL' },
    );
    expect(codes(changed)).toEqual(['quant']);
    expect(changed.findings[0]?.message).toContain('the known exception for this row is UD-Q4_K_XL');
  });

  it('reports a pull tag that is not the quant the row labels', () => {
    const verdict = judgeHfGgufRow(
      { ...arete, backendModelId: 'hf.co/bartowski/NousResearch_Arete-27B-GGUF:UD-Q4_K_XL' },
      manifest('arete-27b.manifest'),
    );
    expect(codes(verdict)).toEqual(['quant']);
    expect(verdict.findings[0]?.message).toContain('UD-Q4_K_XL');
  });
});

describe('Hugging Face repo rows (vLLM and oMLX)', () => {
  const repo = (slug: string, config?: string, tweak?: (model: HfModel) => void): Read<HfRepoRead> => {
    const model = fixtureJson<HfModel>(`hf-repo/${slug}.api.json`);
    tweak?.(model);
    return { ok: true, value: { model, config: config ? fixtureJson<Record<string, unknown>>(`hf-repo/${config}.config.json`) : undefined } };
  };
  // Qwen/Qwen3-8B: five safetensors shards totalling 16,381,516,776 bytes, max_position_embeddings 40960.
  const qwen = row({ id: 'qwen3-8b-vllm', backend: 'vllm', backendModelId: 'Qwen/Qwen3-8B', gb: 16.4, contextWindow: 32_000 });

  it('passes an open repo whose weights and context window match, and says what it read', () => {
    const verdict = judgeHfRepoRow(qwen, repo('qwen3-8b', 'qwen3-8b'));
    expect(verdict.findings).toEqual([]);
    expect(verdict.facts).toEqual(['16.38 GB', 'max_position_embeddings 40960']);
  });

  describe('gated, private and missing repos', () => {
    it('fails a gated repo, which the Hub cannot read without a token', () => {
      const verdict = judgeHfRepoRow(qwen, repo('llama-3.2-3b-instruct'));
      expect(verdict.findings.map((f) => [f.level, f.code])).toEqual([['fail', 'gated']]);
      expect(verdict.findings[0]?.message).toContain('"manual"');
    });

    it('fails an automatically gated repo the same way', () => {
      expect(
        codes(
          judgeHfRepoRow(
            qwen,
            repo('qwen3-8b', 'qwen3-8b', (model) => (model.gated = 'auto')),
          ),
        ),
      ).toEqual(['gated']);
    });

    it('fails a private or disabled repo as missing', () => {
      expect(
        codes(
          judgeHfRepoRow(
            qwen,
            repo('qwen3-8b', 'qwen3-8b', (model) => (model.private = true)),
          ),
        ),
      ).toEqual(['missing']);
      expect(
        codes(
          judgeHfRepoRow(
            qwen,
            repo('qwen3-8b', 'qwen3-8b', (model) => (model.disabled = true)),
          ),
        ),
      ).toEqual(['missing']);
    });

    it('does not pass a repo whose record says nothing about gating', () => {
      const verdict = judgeHfRepoRow(
        qwen,
        repo('qwen3-8b', 'qwen3-8b', (model) => (model.gated = undefined)),
      );
      expect(verdict.findings.map((f) => [f.level, f.code])).toEqual([['unverified', 'unverified']]);
    });

    it('fails a repo Hugging Face answers 401 for as missing', () => {
      const refusal = fixtureJson<{ error: string }>('hf-repo/missing.401.json');
      const verdict = judgeHfRepoRow(qwen, { ok: false, status: 401, message: refusal.error });
      expect(verdict.findings.map((f) => [f.level, f.code])).toEqual([['fail', 'missing']]);
    });
  });

  describe('weights against gb', () => {
    it('sums the .safetensors at the root only, because a subfolder such as original/ is a second copy', () => {
      const gptOss = fixtureJson<HfModel>('hf-repo/gpt-oss-20b.api.json');
      const everyFile = (gptOss.siblings ?? []).filter((f) => f.rfilename?.endsWith('.safetensors')).reduce((sum, f) => sum + (f.size ?? 0), 0);
      expect(everyFile).toBe(27_522_617_888);
      expect(rootWeightBytes(gptOss.siblings ?? []).total).toBe(13_761_316_904);
      const verdict = judgeHfRepoRow(
        row({ id: 'gpt-oss-20b-vllm', backend: 'vllm', backendModelId: 'openai/gpt-oss-20b', gb: 13.8, contextWindow: 131_000 }),
        repo('gpt-oss-20b', 'gpt-oss-20b'),
      );
      expect(verdict.findings).toEqual([]);
      expect(verdict.facts).toEqual(['13.76 GB', 'max_position_embeddings 131072']);
    });

    it('says when a gb counted files outside the root, which vLLM and mlx-lm do not read', () => {
      // mlx-community/Ornith-1.5-35B-A3B-OptiQ-4bit: five root shards (22.16 GB) and optiq/ with a draft head and a vision tower (1.38 GB).
      const ornith = row({
        id: 'ornith-1-5-35b-mlx',
        backend: 'omlx',
        backendModelId: 'mlx-community/Ornith-1.5-35B-A3B-OptiQ-4bit',
        gb: 23.5,
        contextWindow: 256_000,
      });
      const counted = judgeHfRepoRow(ornith, repo('ornith-1.5-35b-a3b-optiq-4bit'));
      expect(codes(counted).filter((code) => code === 'size-gb')).toEqual(['size-gb']);
      const message = counted.findings.find((f) => f.code === 'size-gb')?.message ?? '';
      expect(message).toContain('root .safetensors total 22.16 GB');
      expect(message).toContain('matches the whole repo (23.55 GB)');
      expect(message).toContain('optiq/mtp.safetensors, optiq/optiq_vision.safetensors');
      // The root shards alone are what the engines load, so a gb of 22.2 passes and says nothing about optiq/.
      const rootOnly = judgeHfRepoRow({ ...ornith, gb: 22.2 }, repo('ornith-1.5-35b-a3b-optiq-4bit'));
      expect(codes(rootOnly).includes('size-gb')).toBe(false);
      // A gb that matches neither the root nor the whole repo gets no hint.
      const neither = judgeHfRepoRow({ ...ornith, gb: 30 }, repo('ornith-1.5-35b-a3b-optiq-4bit'));
      expect(neither.findings.find((f) => f.code === 'size-gb')?.message).not.toContain('whole repo');
    });

    it('allows a gb that is off by one decimal of rounding and reports more', () => {
      // 16.3815 GB of weights: 16.3 is 0.08 off, 16.2 is 0.18 off.
      expect(codes(judgeHfRepoRow({ ...qwen, gb: 16.3 }, repo('qwen3-8b', 'qwen3-8b')))).toEqual([]);
      const off = judgeHfRepoRow({ ...qwen, gb: 16.2 }, repo('qwen3-8b', 'qwen3-8b'));
      expect(codes(off)).toEqual(['size-gb']);
      expect(off.findings[0]?.message).toContain('16.38 GB');
    });

    it('allows half a percent of a large model, where one decimal of rounding is too tight', () => {
      const big = (gb: number) =>
        judgeHfRepoRow(
          { ...qwen, gb },
          repo('qwen3-8b', 'qwen3-8b', (model) => (model.siblings = [{ rfilename: 'model.safetensors', size: 420_000_000_000 }])),
        );
      expect(codes(big(419.5))).toEqual([]);
      expect(codes(big(418.5))).toEqual([]);
      expect(codes(big(417))).toEqual(['size-gb']);
    });

    it('reports a repo with no safetensors at its root', () => {
      const verdict = judgeHfRepoRow(
        qwen,
        repo('qwen3-8b', 'qwen3-8b', (model) => (model.siblings = [{ rfilename: 'original/model.safetensors', size: 1 }])),
      );
      expect(codes(verdict)).toEqual(['no-weights']);
    });

    it('does not read a record with no file list as a repo with no weights', () => {
      const verdict = judgeHfRepoRow(
        qwen,
        repo('qwen3-8b', 'qwen3-8b', (model) => (model.siblings = undefined)),
      );
      expect(verdict.findings.map((f) => [f.level, f.code])).toEqual([['unverified', 'unverified']]);
      expect(verdict.findings[0]?.message).toContain('siblings');
    });

    it('fails a repo with no weight file at its root, which has nothing to load, and warns on one whose weights are in another format', () => {
      const none = judgeHfRepoRow(
        qwen,
        repo(
          'qwen3-8b',
          'qwen3-8b',
          (model) =>
            (model.siblings = [
              { rfilename: 'README.md', size: 7 },
              { rfilename: 'config.json', size: 700 },
            ]),
        ),
      );
      expect(none.findings.map((f) => [f.level, f.code])).toEqual([['fail', 'no-weights']]);
      expect(
        judgeHfRepoRow(
          qwen,
          repo('qwen3-8b', 'qwen3-8b', (model) => (model.siblings = [])),
        ).findings.map((f) => f.level),
      ).toEqual(['fail']);
      const gguf = judgeHfRepoRow(
        qwen,
        repo('qwen3-8b', 'qwen3-8b', (model) => (model.siblings = [{ rfilename: 'qwen3-8b-q4_k_m.gguf', size: 5_000_000_000 }])),
      );
      expect(gguf.findings.map((f) => [f.level, f.code])).toEqual([['warn', 'no-weights']]);
      expect(gguf.findings[0]?.message).toContain('qwen3-8b-q4_k_m.gguf');
      // Weights in a subfolder are not at the root.
      expect(
        judgeHfRepoRow(
          qwen,
          repo('qwen3-8b', 'qwen3-8b', (model) => (model.siblings = [{ rfilename: 'original/model.bin', size: 1 }])),
        ).findings[0]?.level,
      ).toBe('fail');
    });

    it('does not guess when the record lists no size for a weights file', () => {
      const verdict = judgeHfRepoRow(
        qwen,
        repo('qwen3-8b', 'qwen3-8b', (model) => (model.siblings = [{ rfilename: 'model-00001-of-00002.safetensors' }])),
      );
      expect(verdict.findings.map((f) => [f.level, f.code])).toEqual([['unverified', 'unverified']]);
    });
  });

  describe('context window against max_position_embeddings', () => {
    it('reports a repo whose config reaches less than the window the row advertises', () => {
      const verdict = judgeHfRepoRow({ ...qwen, contextWindow: 131_072 }, repo('qwen3-8b', 'qwen3-8b'));
      expect(codes(verdict)).toEqual(['ctx']);
      expect(verdict.findings[0]?.message).toContain('is 40960, below the 131072 tokens');
    });

    it('passes a window equal to the limit', () => {
      expect(codes(judgeHfRepoRow({ ...qwen, contextWindow: 40_960 }, repo('qwen3-8b', 'qwen3-8b')))).toEqual([]);
      expect(codes(judgeHfRepoRow({ ...qwen, contextWindow: 40_961 }, repo('qwen3-8b', 'qwen3-8b')))).toEqual(['ctx']);
    });

    it("reads a multimodal repo's text model, not its vision tower", () => {
      // gemma-4-31B-it: text_config.max_position_embeddings 262144, vision_config.max_position_embeddings 131072.
      const gemma = row({ id: 'gemma4-31b-vllm', backend: 'vllm', backendModelId: 'google/gemma-4-31B-it', gb: 62.5, contextWindow: 256_000 });
      const verdict = judgeHfRepoRow(gemma, repo('gemma-4-31b-it', 'gemma-4-31b-it'));
      expect(verdict.findings).toEqual([]);
      expect(verdict.facts).toEqual(['62.55 GB', 'max_position_embeddings 262144']);
      const over = judgeHfRepoRow({ ...gemma, contextWindow: 262_145 }, repo('gemma-4-31b-it', 'gemma-4-31b-it'));
      expect(over.findings[0]?.message).toContain('text_config.max_position_embeddings is 262144');
    });

    it('says so when it cannot check: no config.json, or none of the keys in it', () => {
      expect(codes(judgeHfRepoRow(qwen, repo('qwen3-8b')))).toEqual(['no-ctx']);
      const empty: Read<HfRepoRead> = { ok: true, value: { model: fixtureJson<HfModel>('hf-repo/qwen3-8b.api.json'), config: { model_type: 'x' } } };
      expect(codes(judgeHfRepoRow(qwen, empty))).toEqual(['no-ctx']);
    });

    describe('contextLimit', () => {
      it('prefers the top level, then the text model, and ignores other sections', () => {
        expect(contextLimit({ max_position_embeddings: 8192, text_config: { max_position_embeddings: 4096 } })).toEqual({
          value: 8192,
          path: 'max_position_embeddings',
        });
        expect(contextLimit({ text_config: { max_position_embeddings: 4096 }, vision_config: { max_position_embeddings: 99 } })).toEqual({
          value: 4096,
          path: 'text_config.max_position_embeddings',
        });
        expect(contextLimit({ llm_config: { max_position_embeddings: 2048 } })?.path).toBe('llm_config.max_position_embeddings');
        expect(contextLimit({ vision_config: { max_position_embeddings: 99 } })).toBeUndefined();
        expect(contextLimit({ max_position_embeddings: 'big' })).toBeUndefined();
      });
    });
  });
});

describe('statusOf', () => {
  const finding = (level: Finding['level']): Finding => ({ level, code: 'quant', message: level });

  it('is the worst finding a row has: fail, then unread, then warn, then ok', () => {
    expect(statusOf([])).toBe('ok');
    expect(statusOf([finding('warn')])).toBe('warn');
    expect(statusOf([finding('warn'), finding('unverified')])).toBe('unverified');
    expect(statusOf([finding('unverified'), finding('warn'), finding('fail')])).toBe('fail');
    expect(statusOf([finding('fail'), finding('warn')])).toBe('fail');
  });
});
