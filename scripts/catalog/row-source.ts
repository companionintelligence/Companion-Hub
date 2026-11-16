/**
 * Where the row checker gets each row's claims: `CURATED_MODELS` for most of them, the generated geometry table for the
 * size of a row's files, and the catalog source for the one column the module does not keep.
 *
 * WHY the source: `CURATED_MODELS` replaces an Ollama row's download size with the size of its files
 * (`withFileFootprint`), so the table's authored `gb` no longer exists once the module has loaded, and `gb` is the
 * column that the library page or Hugging Face supplied by hand and that goes stale. `readAuthoredRows` reads it back from
 * the TOON tables. It is checked against the module for every oMLX and vLLM row (their `diskMb` is still `gb` x 1024), so a
 * change to the table format that this reader does not follow fails a test instead of quietly checking the wrong number.
 */
import { CURATED_MODELS } from '../../packages/backend/src/modules/inference/catalog/curated-models';
import { GGUF_KV_GEOMETRY } from '../../packages/backend/src/modules/inference/catalog/kv-geometry.generated';
import type { CheckRow } from './row-checks';

/** Every `llms[N|]{id,...,gb,...}:` table in the catalog source, as the `gb` each row id authors. */
export function readAuthoredRows(source: string): Map<string, number> {
  const lines = source.split('\n');
  const gbById = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const header = (lines[i] ?? '').trim().match(/^llms\[(\d+)\|\]\{(.+)\}:$/);
    if (!header) continue;
    const declared = Number(header[1]);
    const columns = (header[2] ?? '').split(',');
    const idAt = columns.indexOf('id');
    const gbAt = columns.indexOf('gb');
    if (idAt < 0 || gbAt < 0) throw new Error(`the table at line ${i + 1} has no id and gb columns: ${columns.join(',')}`);
    let read = 0;
    for (let j = i + 1; j < lines.length && read < declared; j++) {
      const line = (lines[j] ?? '').trim();
      if (!line) continue;
      const cells = line.split('|').map((cell) => cell.trim());
      const id = cells[idAt] ?? '';
      if (gbById.has(id)) throw new Error(`the row id ${id} appears twice in the catalog tables (line ${j + 1})`);
      gbById.set(id, Number(cells[gbAt]));
      read++;
    }
    if (read !== declared) throw new Error(`the table at line ${i + 1} declares ${declared} rows but ${read} follow it`);
  }
  return gbById;
}

/** Every LLM row of the catalog with the claims the checker tests, in catalog order. */
export function loadRows(source: string): CheckRow[] {
  const authored = readAuthoredRows(source);
  return CURATED_MODELS.filter((model) => model.modality === 'llm').map((model) => {
    const gb = authored.get(model.id);
    if (gb === undefined || !(gb > 0))
      throw new Error(`no authored gb for the row ${model.id}: the catalog source has no TOON row with that id and a gb above zero`);
    return {
      id: model.id,
      backend: model.backend,
      backendModelId: model.backendModelId,
      quant: model.runtime.quantization ?? '',
      gb,
      contextWindow: model.runtime.contextWindow,
      fileBytes: GGUF_KV_GEOMETRY[model.id]?.fileBytes,
      gpuVendors: model.requirements.gpuVendors,
    };
  });
}
