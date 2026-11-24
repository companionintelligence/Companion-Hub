import { describe, expect, it } from 'vitest';
import type { CuratedModel } from '@ci-hub/common/types';
import {
  engineModelKey,
  handoutIdForCatalogModel,
  isCatalogModelInstalled,
  isCuratedModelInstalled,
  isOllamaTagForCatalogModel,
  isOllamaTagForModel,
  isServedModelForCatalog,
  resolveInstalledCatalogIds,
  resolveInstalledCatalogIdsFromServedModels,
  sameEngineModelId,
  servedIdForCatalogModel,
  trackedPullCounts,
} from '../model-availability.util';

const model = {
  id: 'hermes4-70b',
  backendModelId: 'hermes4:70b',
} as CuratedModel;

describe('model-availability.util', () => {
  it('matches exact and tagged Ollama names', () => {
    expect(isOllamaTagForModel('hermes4:70b', 'hermes4:70b')).toBe(true);
    expect(isOllamaTagForModel('hermes4:70b-q4_K_M', 'hermes4:70b')).toBe(true);
    expect(isOllamaTagForModel('phi4-mini', 'hermes4:70b')).toBe(false);
  });

  it('detects installed catalog models from Ollama tags', () => {
    expect(isCuratedModelInstalled(model, ['hermes4:70b'])).toBe(true);
    expect(isCuratedModelInstalled(model, ['other:8b'])).toBe(false);
    expect(isCuratedModelInstalled(model, [], true)).toBe(true);
  });

  it('resolves installed catalog ids from a catalog slice', () => {
    const catalog = [model, { id: 'phi-4-mini', backendModelId: 'phi4-mini' } as CuratedModel];
    expect(resolveInstalledCatalogIds(catalog, ['hermes4:70b-q4_K_M'])).toEqual(['hermes4-70b']);
  });

  describe('longest match against the catalog', () => {
    const plain = { id: 'qwen3-8-27b', backendModelId: 'qwen3.8:27b' } as CuratedModel;
    const mtp = { id: 'qwen3-8-27b-mtp', backendModelId: 'qwen3.8:27b-mtp-q4_K_M' } as CuratedModel;
    const nomic = { id: 'nomic-embed-text', backendModelId: 'nomic-embed-text' } as CuratedModel;
    const nomicV2 = { id: 'nomic-embed-text-v2-moe', backendModelId: 'nomic-embed-text-v2-moe' } as CuratedModel;
    const catalog = [plain, mtp, nomic, nomicV2];
    const ids = catalog.map((m) => m.backendModelId);

    it('does not credit a tag to a shorter row when a longer row spells that tag out', () => {
      expect(isOllamaTagForCatalogModel('qwen3.8:27b-mtp-q4_K_M', 'qwen3.8:27b', ids)).toBe(false);
      expect(isOllamaTagForCatalogModel('qwen3.8:27b-mtp-q4_K_M', 'qwen3.8:27b-mtp-q4_K_M', ids)).toBe(true);
      expect(isOllamaTagForCatalogModel('nomic-embed-text-v2-moe', 'nomic-embed-text', ids)).toBe(false);
    });

    it('keeps quant-suffix tolerance for tags no catalog row spells out', () => {
      expect(isOllamaTagForCatalogModel('qwen3.8:27b-q4_K_M', 'qwen3.8:27b', ids)).toBe(true);
      expect(isOllamaTagForCatalogModel('qwen3.8:27b', 'qwen3.8:27b', ids)).toBe(true);
      expect(isOllamaTagForCatalogModel('nomic-embed-text:latest', 'nomic-embed-text', ids)).toBe(true);
    });

    it('reports only the MTP row installed when only the MTP tag is pulled', () => {
      expect(resolveInstalledCatalogIds(catalog, ['qwen3.8:27b-mtp-q4_K_M', 'nomic-embed-text:latest'])).toEqual([
        'qwen3-8-27b-mtp',
        'nomic-embed-text',
      ]);
      expect(isCuratedModelInstalled(plain, ['qwen3.8:27b-mtp-q4_K_M'], false, ids)).toBe(false);
      expect(isCuratedModelInstalled(mtp, ['qwen3.8:27b-mtp-q4_K_M'], false, ids)).toBe(true);
    });

    it('takes the exclusion set from the full catalog when the slice omits the longer row', () => {
      // A tier filter can drop the MTP row from the slice while the plain row survives;
      // the plain row must still not claim the MTP tag.
      expect(resolveInstalledCatalogIds([plain], ['qwen3.8:27b-mtp-q4_K_M'], undefined, ids)).toEqual([]);
      // Without the full set the slice can only see itself, and the legacy prefix rule applies.
      expect(resolveInstalledCatalogIds([plain], ['qwen3.8:27b-mtp-q4_K_M'])).toEqual(['qwen3-8-27b']);
    });

    it('still honours a tracked pull regardless of tag shape', () => {
      expect(isCuratedModelInstalled(plain, [], true, ids)).toBe(true);
    });
  });
  // A model removed with `ollama rm` stayed on the registry as pulled, and the handout believed it.
  // Only Ollama's own answer outranks the record: Lemonade answers healthy with an empty list when
  // its model read fails, so the record must keep counting there.
  describe('trackedPullCounts', () => {
    it("lets Ollama's own list decide for an Ollama pull once Ollama has answered", () => {
      expect(trackedPullCounts({ state: 'pulled', backend: 'ollama' }, 'ollama')).toBe(false);
      expect(trackedPullCounts({ state: 'pinned', backend: 'ollama' }, 'ollama')).toBe(false);
    });

    it('keeps counting the record while Ollama cannot be asked', () => {
      expect(trackedPullCounts({ state: 'pulled', backend: 'ollama' }, null)).toBe(true);
      expect(trackedPullCounts({ state: 'loaded', backend: 'ollama' }, null)).toBe(true);
    });

    it("keeps counting a Lemonade, vLLM or oMLX pull whatever that engine lists, and an Ollama pull against another engine's list", () => {
      expect(trackedPullCounts({ state: 'pulled', backend: 'lemonade' }, 'lemonade')).toBe(true);
      expect(trackedPullCounts({ state: 'pulled', backend: 'vllm' }, 'vllm')).toBe(true);
      expect(trackedPullCounts({ state: 'pinned', backend: 'omlx' }, 'omlx')).toBe(true);
      expect(trackedPullCounts({ state: 'pulled', backend: 'ollama' }, 'lemonade')).toBe(true);
    });

    it('never counts a download in progress, a failed one, or no record', () => {
      expect(trackedPullCounts({ state: 'pulling', backend: 'lemonade' }, null)).toBe(false);
      expect(trackedPullCounts({ state: 'error', backend: 'lemonade' }, null)).toBe(false);
      expect(trackedPullCounts(undefined, null)).toBe(false);
    });
  });
  // Lemonade 10.2.0, the fleet's apt package, lists a model the Hub registered only as `user.<id>`.
  // Matching the bare id alone read the embedder the Hub had just registered as missing.
  describe('Lemonade user-namespace spelling', () => {
    const v15 = { id: 'nomic-embed-text-v1-5-lemonade', backend: 'lemonade', backendModelId: 'nomic-embed-text-v1.5-GGUF' } as CuratedModel;
    const ollamaNomic = { id: 'nomic-embed-text', backend: 'ollama', backendModelId: 'nomic-embed-text' } as CuratedModel;

    it('treats user.<id> as serving catalog <id> on Lemonade, and returns the listed spelling', () => {
      expect(servedIdForCatalogModel(v15, ['user.nomic-embed-text-v1.5-GGUF'])).toBe('user.nomic-embed-text-v1.5-GGUF');
      expect(servedIdForCatalogModel(v15, ['nomic-embed-text-v1.5-GGUF'])).toBe('nomic-embed-text-v1.5-GGUF');
      expect(isServedModelForCatalog(v15, ['user.nomic-embed-text-v1.5-GGUF'])).toBe(true);
      expect(isServedModelForCatalog(v15, ['nomic-embed-text-v1-GGUF'])).toBe(false);
    });

    it('never applies the namespace to another engine', () => {
      expect(servedIdForCatalogModel(ollamaNomic, ['user.nomic-embed-text'])).toBeNull();
    });

    it('counts a user.-listed model as installed on every availability path', () => {
      expect(isCatalogModelInstalled(v15, ['user.nomic-embed-text-v1.5-GGUF'])).toBe(true);
      expect(resolveInstalledCatalogIdsFromServedModels([v15], ['user.nomic-embed-text-v1.5-GGUF'], 'lemonade')).toEqual([
        'nomic-embed-text-v1-5-lemonade',
      ]);
    });
  });

  // oMLX 0.7.3.dev1, measured: GET /v1/models lists `Qwen3-8B-4bit` for a model directory (flat, or under an
  // `mlx-community/` folder) and `mlx-community--Qwen3-8B-4bit` for the Hugging Face cache. The catalog row says
  // `mlx-community/Qwen3-8B-4bit`, which no oMLX listing ever carries.
  describe('oMLX spellings', () => {
    const qwen = { id: 'qwen3-8b-mlx', backend: 'omlx', backendModelId: 'mlx-community/Qwen3-8B-4bit' } as CuratedModel;
    const qwen8bit = { id: 'qwen3-8b-8bit-mlx', backend: 'omlx', backendModelId: 'mlx-community/Qwen3-8B-8bit' } as CuratedModel;
    const llama = { id: 'llama3-2-3b-mlx', backend: 'omlx', backendModelId: 'mlx-community/Llama-3.2-3B-Instruct-4bit' } as CuratedModel;

    it.each([
      ['a model directory', 'Qwen3-8B-4bit'],
      ['the Hugging Face cache', 'mlx-community--Qwen3-8B-4bit'],
      ['a model directory spelled in another case', 'qwen3-8b-4bit'],
    ])('finds the model oMLX lists from %s, and returns the spelling it lists', (_layout, listed) => {
      expect(servedIdForCatalogModel(qwen, [listed])).toBe(listed);
      expect(isServedModelForCatalog(qwen, [listed])).toBe(true);
    });

    it('still finds a model an operator aliased to the catalog id', () => {
      expect(servedIdForCatalogModel(qwen, ['mlx-community/Qwen3-8B-4bit'])).toBe('mlx-community/Qwen3-8B-4bit');
    });

    it('does not find another build of the model, another model, or one hidden behind an alias', () => {
      expect(isServedModelForCatalog(qwen, ['Qwen3-8B-8bit'])).toBe(false);
      expect(isServedModelForCatalog(qwen, ['Llama-3.2-3B-Instruct-4bit', 'mlx-community--Qwen3-4B-4bit'])).toBe(false);
      expect(isServedModelForCatalog(qwen, ['my-qwen'])).toBe(false);
    });

    it("finds this organization's cache entry, and not another publisher's of the same name that oMLX lists first", () => {
      // oMLX lists its models sorted by id, so `lmstudio-community--` comes before `mlx-community--`.
      expect(servedIdForCatalogModel(qwen, ['lmstudio-community--Qwen3-8B-4bit', 'mlx-community--Qwen3-8B-4bit'])).toBe(
        'mlx-community--Qwen3-8B-4bit',
      );
      expect(servedIdForCatalogModel(qwen, ['lmstudio-community--Qwen3-8B-4bit'])).toBeNull();
    });

    it('marks only the rows oMLX lists as installed', () => {
      const served = ['Qwen3-8B-4bit', 'LiquidAI--LFM2.5-1.2B-Instruct-MLX-bf16'];

      expect(resolveInstalledCatalogIdsFromServedModels([qwen, qwen8bit, llama], served, 'omlx')).toEqual(['qwen3-8b-mlx']);
    });

    it('never folds the spellings for another engine', () => {
      const vllm = { id: 'qwen3-8b-vllm', backend: 'vllm', backendModelId: 'mlx-community/Qwen3-8B-4bit' } as CuratedModel;

      expect(servedIdForCatalogModel(vllm, ['Qwen3-8B-4bit'])).toBeNull();
      expect(servedIdForCatalogModel(vllm, ['mlx-community/Qwen3-8B-4bit'])).toBe('mlx-community/Qwen3-8B-4bit');
    });

    it('names a model for an app or a request by the spelling oMLX lists, and the catalog spelling when it lists none', () => {
      expect(handoutIdForCatalogModel(qwen, ['mlx-community--Qwen3-8B-4bit'])).toBe('mlx-community--Qwen3-8B-4bit');
      expect(handoutIdForCatalogModel(qwen, ['Qwen3-8B-4bit'])).toBe('Qwen3-8B-4bit');
      expect(handoutIdForCatalogModel(qwen, ['Llama-3.2-3B-Instruct-4bit'])).toBe('mlx-community/Qwen3-8B-4bit');
      expect(handoutIdForCatalogModel(qwen, [])).toBe('mlx-community/Qwen3-8B-4bit');
    });

    // Only oMLX lists a model under a name the catalog does not spell, so a handout for any other engine is the
    // catalog's, as it was before this: Lemonade's `user.` spelling is applied where the Hub registers a model.
    it('leaves the handout of another engine as the catalog spells it', () => {
      const ollama = { id: 'phi-4-mini', backend: 'ollama', backendModelId: 'phi4-mini' } as CuratedModel;
      const lemonade = { id: 'nomic-embed-text-v1-5-lemonade', backend: 'lemonade', backendModelId: 'nomic-embed-text-v1.5-GGUF' } as CuratedModel;

      expect(handoutIdForCatalogModel(ollama, ['phi4-mini'])).toBe('phi4-mini');
      expect(handoutIdForCatalogModel(ollama, ['phi4-mini:latest'])).toBe('phi4-mini');
      expect(handoutIdForCatalogModel(lemonade, ['user.nomic-embed-text-v1.5-GGUF'])).toBe('nomic-embed-text-v1.5-GGUF');
    });

    it('keys every spelling of a model alike, for residency and de-duplication', () => {
      const keys = ['mlx-community/Qwen3-8B-4bit', 'Qwen3-8B-4bit', 'mlx-community--Qwen3-8B-4bit'].map((id) => engineModelKey('omlx', id));

      expect(new Set(keys).size).toBe(1);
      expect(sameEngineModelId('omlx', 'mlx-community/Qwen3-8B-4bit', 'Qwen3-8B-4bit')).toBe(true);
      expect(sameEngineModelId('omlx', 'mlx-community/Qwen3-8B-4bit', 'mlx-community--Qwen3-8B-4bit')).toBe(true);
      expect(sameEngineModelId('omlx', 'mlx-community/Qwen3-8B-4bit', 'Qwen3-8B-8bit')).toBe(false);
    });

    it("tells two publishers' builds of one name apart when it compares two ids, though a key cannot", () => {
      expect(sameEngineModelId('omlx', 'mlx-community/Qwen3-8B-4bit', 'lmstudio-community--Qwen3-8B-4bit')).toBe(false);
      expect(sameEngineModelId('omlx', 'mlx-community/Qwen3-8B-4bit', 'Foo--Qwen3-8B-4bit')).toBe(false);
      expect(engineModelKey('omlx', 'lmstudio-community--Qwen3-8B-4bit')).toBe(engineModelKey('omlx', 'mlx-community--Qwen3-8B-4bit'));
    });

    it('keys the spellings apart on every other engine', () => {
      expect(sameEngineModelId('vllm', 'mlx-community/Qwen3-8B-4bit', 'Qwen3-8B-4bit')).toBe(false);
      expect(sameEngineModelId('ollama', 'mlx-community/Qwen3-8B-4bit', 'mlx-community--Qwen3-8B-4bit')).toBe(false);
    });
  });
});
