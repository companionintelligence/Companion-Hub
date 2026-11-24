import { describe, expect, it } from 'vitest';
import { assertServedFile, isShardedRefusal, pickQuantFile, resolveHuggingFaceGguf, selectGguf } from '../catalog/gguf-files';

const files = (...paths: string[]) => paths.map((path) => ({ path }));

// Real file trees (paths and sizes) from huggingface.co/api/models/<repo>/tree/main on 2026-11-15, and what Hugging Face's
// Ollama registry endpoint answered for the quant: the layouts that picked the wrong file, or that no rule had to cover.
// AngelSlim/Hy3-GGUF lists `-mtp` ahead of the plain file ('-' sorts before '.'); the manifest serves the plain 182.33 GB file.
const HY3 = [
  { path: 'Hy3-Q4_K_M-mtp.gguf', size: 184_656_950_752 },
  { path: 'Hy3-Q4_K_M.gguf', size: 182_328_371_648 },
];
// JetBrains' Mellum2.1 repo: two names end with the quant, and the manifest serves the root one.
const MELLUM = [
  { path: 'Mellum2.1-12B-A2.5B-Thinking-Q4_K_M.gguf', size: 8_071_295_264 },
  { path: 'mtp/Mellum2.1-12B-A2.5B-Thinking-MTP-Q4_K_M.gguf', size: 8_329_317_344 },
];
// Qwen/Qwen2.5-Coder-32B-Instruct-GGUF: a plain file and three shards of one quant side by side; the endpoint answers 400 "sharded".
const QWEN_CODER = [
  { path: 'qwen2.5-coder-32b-instruct-q4_k_m-00001-of-00003.gguf', size: 7_990_120_512 },
  { path: 'qwen2.5-coder-32b-instruct-q4_k_m-00002-of-00003.gguf', size: 7_943_826_304 },
  { path: 'qwen2.5-coder-32b-instruct-q4_k_m-00003-of-00003.gguf', size: 3_917_389_312 },
  { path: 'qwen2.5-coder-32b-instruct-q4_k_m.gguf', size: 19_851_335_872 },
];
// unsloth/GLM-5.2-GGUF: eleven shards in a directory named for the quant; the endpoint answers 400 "only sharded".
const GLM = [
  { path: 'UD-Q4_K_XL/GLM-5.2-UD-Q4_K_XL-00001-of-00011.gguf', size: 9_423_744 },
  { path: 'UD-Q4_K_XL/GLM-5.2-UD-Q4_K_XL-00002-of-00011.gguf', size: 49_433_942_336 },
  ...[3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
    path: `UD-Q4_K_XL/GLM-5.2-UD-Q4_K_XL-${String(n).padStart(5, '0')}-of-00011.gguf`,
    size: 48_566_415_136,
  })),
  { path: 'UD-Q4_K_XL/GLM-5.2-UD-Q4_K_XL-00011-of-00011.gguf', size: 29_314_424_736 },
];

const MODEL = 'application/vnd.ollama.image.model';
const layers = (model: number, ...others: [string, number][]) => [
  { mediaType: MODEL, size: model },
  ...others.map(([kind, size]) => ({ mediaType: `application/vnd.ollama.image.${kind}`, size })),
];

describe('pickQuantFile', () => {
  it('takes the file named for the quant, not a sibling whose name continues after it, whichever is listed first', () => {
    expect(pickQuantFile(HY3, 'Q4_K_M')).toBe(HY3[1]);
    expect(pickQuantFile([...HY3].reverse(), 'Q4_K_M')).toBe(HY3[1]);
  });

  it('takes the name nearest the root when several end with the quant, and the first listed among equals', () => {
    expect(pickQuantFile(MELLUM, 'Q4_K_M')).toBe(MELLUM[0]);
    expect(pickQuantFile([...MELLUM].reverse(), 'Q4_K_M')).toBe(MELLUM[0]);
    const first = { path: 'a/Model-Q4_K_M.gguf' };
    const second = { path: 'b/Model-Q4_K_M.gguf' };
    expect(pickQuantFile([first, second], 'Q4_K_M')).toBe(first);
    expect(pickQuantFile([second, first], 'Q4_K_M')).toBe(second);
  });

  it('takes a first shard over a plain file at the same depth, whichever is listed first', () => {
    expect(pickQuantFile(QWEN_CODER, 'Q4_K_M')).toBe(QWEN_CODER[0]);
    expect(pickQuantFile([...QWEN_CODER].reverse(), 'Q4_K_M')).toBe(QWEN_CODER[0]);
  });

  it('takes the first shard of a split quant, and ignores the other shards', () => {
    const picked = pickQuantFile(
      files('Hy3-Q4_K_M/Hy3-Q4_K_M-00002-of-00005.gguf', 'Hy3-Q4_K_M/Hy3-Q4_K_M-00001-of-00005.gguf', 'Hy3-Q4_K_M/Hy3-Q4_K_M-00005-of-00005.gguf'),
      'Q4_K_M',
    );
    expect(picked?.path).toBe('Hy3-Q4_K_M/Hy3-Q4_K_M-00001-of-00005.gguf');
    expect(pickQuantFile(files('Hy3-Q4_K_M/Hy3-Q4_K_M-00002-of-00005.gguf'), 'Q4_K_M')).toBeUndefined();
    // gguf-split always writes five digits, and the shard collector in selectGguf reads only that shape.
    expect(pickQuantFile(files('Hy3-Q4_K_M-1-of-5.gguf', 'Hy3-Q4_K_M-001-of-00005.gguf'), 'Q4_K_M')).toBeUndefined();
  });

  it('ignores case, and a directory or prefix before the name', () => {
    expect(pickQuantFile(files('command-a-plus-05-2026-q4_k_m.gguf'), 'Q4_K_M')?.path).toBe('command-a-plus-05-2026-q4_k_m.gguf');
    expect(pickQuantFile(files('some/dir/Mellum2.1-Q4_K_M.gguf'), 'Q4_K_M')?.path).toBe('some/dir/Mellum2.1-Q4_K_M.gguf');
    expect(pickQuantFile(files('Q4_K_M.gguf'), 'Q4_K_M')?.path).toBe('Q4_K_M.gguf');
  });

  it('does not take a longer quant or a name the quant is only part of, but takes a prefixed quant such as UD-Q4_K_XL', () => {
    expect(pickQuantFile(files('Model-Q4_K_M.gguf', 'Model-Q4_K_L.gguf'), 'Q4_K')).toBeUndefined();
    expect(pickQuantFile(files('Model-UD-Q4_K_XL.gguf'), 'Q4_K_XL')?.path).toBe('Model-UD-Q4_K_XL.gguf');
    expect(pickQuantFile(files('ModelQ4_K_M.gguf'), 'Q4_K_M')).toBeUndefined();
    expect(pickQuantFile(files('Model-IQ4_K_M.gguf'), 'Q4_K_M')).toBeUndefined();
  });

  it('treats the quant as text, not a pattern', () => {
    expect(pickQuantFile(files('Model-Q4XK_M.gguf'), 'Q4.K_M')).toBeUndefined();
    expect(pickQuantFile(files('Model-Q4.K_M.gguf'), 'Q4.K_M')?.path).toBe('Model-Q4.K_M.gguf');
  });
});

describe('selectGguf', () => {
  it('reads the plain Hy3 file and the root Mellum file, not their -mtp siblings, in either listed order', () => {
    for (const order of [HY3, [...HY3].reverse()]) expect(selectGguf(order, 'Q4_K_M')).toEqual({ wanted: HY3[1], fileBytes: 182_328_371_648 });
    for (const order of [MELLUM, [...MELLUM].reverse()]) expect(selectGguf(order, 'Q4_K_M')).toEqual({ wanted: MELLUM[0], fileBytes: 8_071_295_264 });
  });

  it('maps every shard of a split quant: Qwen2.5-Coder beside its plain file, and GLM 5.2 in a quant-named directory', () => {
    expect(selectGguf(QWEN_CODER, 'Q4_K_M')).toEqual({ wanted: QWEN_CODER[0], fileBytes: 19_851_336_128 });
    expect(selectGguf([...QWEN_CODER].reverse(), 'Q4_K_M').wanted).toBe(QWEN_CODER[0]);
    const glm = selectGguf(GLM, 'UD-Q4_K_XL');
    expect(glm.wanted.path).toBe('UD-Q4_K_XL/GLM-5.2-UD-Q4_K_XL-00001-of-00011.gguf');
    expect(glm.fileBytes).toBe(467_289_111_904);
  });

  it('counts only the shards of the set the first shard names, not siblings that share the same prefix', () => {
    const tree = [
      { path: 'Model-Q4_K_M-00001-of-00002.gguf', size: 10 },
      { path: 'Model-Q4_K_M-00002-of-00002.gguf', size: 20 },
      { path: 'Model-Q4_K_M-mtp.gguf', size: 400 },
      { path: 'Model-Q4_K_M-00001-of-00003.gguf', size: 1000 },
      { path: 'Model-Q4_K_M-00002-of-00003.gguf', size: 2000 },
      { path: 'Model-Q4_K_M-00003-of-00003.gguf', size: 3000 },
    ];
    expect(selectGguf(tree, 'Q4_K_M')).toEqual({ wanted: tree[0], fileBytes: 30 });
  });

  it('does not count a sharded sibling set that has the same prefix and the same shard count, in either listed order', () => {
    const tree = [
      { path: 'Model-Q4_K_M-00001-of-00002.gguf', size: 10 },
      { path: 'Model-Q4_K_M-00002-of-00002.gguf', size: 20 },
      { path: 'Model-Q4_K_M-mtp-00001-of-00002.gguf', size: 50_000 },
      { path: 'Model-Q4_K_M-mtp-00002-of-00002.gguf', size: 60_000 },
    ];
    for (const order of [tree, [...tree].reverse()]) expect(selectGguf(order, 'Q4_K_M')).toEqual({ wanted: tree[0], fileBytes: 30 });
  });

  it('does not count the shards of a same-named set in another directory, as JetBrains keeps its MTP files in mtp/', () => {
    const tree = [
      { path: 'Model-Q4_K_M-00001-of-00002.gguf', size: 10 },
      { path: 'Model-Q4_K_M-00002-of-00002.gguf', size: 20 },
      { path: 'mtp/Model-Q4_K_M-00001-of-00002.gguf', size: 7000 },
      { path: 'mtp/Model-Q4_K_M-00002-of-00002.gguf', size: 8000 },
    ];
    for (const order of [tree, [...tree].reverse()]) expect(selectGguf(order, 'Q4_K_M')).toEqual({ wanted: tree[0], fileBytes: 30 });
  });

  it('takes a named file by its name, with or without a directory and whatever its case, and adds the projector a checkpoint names', () => {
    const tree = [
      { path: 'Model-Q4_K_M.gguf', size: 1000 },
      { path: 'sub/Other-Q4_K_M.gguf', size: 2000 },
      { path: 'mmproj-F16.gguf', size: 300 },
    ];
    expect(selectGguf(tree, 'model-q4_k_m.gguf')).toEqual({ wanted: tree[0], fileBytes: 1000 });
    expect(selectGguf(tree, 'Other-Q4_K_M.gguf').wanted).toBe(tree[1]);
    expect(selectGguf(tree, 'Model-Q4_K_M.gguf', 'mmproj-F16.gguf').fileBytes).toBe(1300);
  });

  it('never takes a projector as the weights', () => {
    const tree = [
      { path: 'mmproj-Q4_K_M.gguf', size: 300 },
      { path: 'Model-Q4_K_M.gguf', size: 1000 },
    ];
    expect(selectGguf(tree, 'Q4_K_M').wanted).toBe(tree[1]);
  });

  it('fails, rather than guess, when no file name ends with the quant', () => {
    expect(() => selectGguf(files('Model-Q4_K_M.gguf'), 'Q4_K')).toThrow(/no GGUF named for the quant "Q4_K"/);
    expect(() => selectGguf([HY3[0] as { path: string }], 'Q4_K_M')).toThrow(/no GGUF named for the quant "Q4_K_M"/);
    expect(() => selectGguf(files('Model-Q4_K_M.gguf'), 'Other.gguf')).toThrow(/no GGUF named "Other.gguf"/);
  });
});

describe('isShardedRefusal', () => {
  // What huggingface.co/v2/<repo>/manifests/<quant> answered an `ollama/0.34.0` client on 2026-11-15: all three are HTTP 400.
  const SHARDED =
    '{"error":"This tag is a sharded GGUF. Ollama does not yet support pulling sharded GGUF via the registry; please use a single-file quantization tag or \\"latest\\""}';
  const NOT_LISTED = '{"error":"The specified tag is not available in the repository. Please use another tag or \\"latest\\""}';
  const NOT_A_QUANT = '{"error":"The specified tag is not a valid quantization scheme. Please use another tag or \\"latest\\""}';

  it('is true only for the 400 that says the repo is sharded, not for a quant the repo lacks or that is no quant', () => {
    expect(isShardedRefusal(400, SHARDED)).toBe(true);
    expect(isShardedRefusal(400, NOT_LISTED)).toBe(false);
    expect(isShardedRefusal(400, NOT_A_QUANT)).toBe(false);
  });

  it('is false for any other status, whatever the body says', () => {
    expect(isShardedRefusal(401, '{"error":"Invalid username or password."}')).toBe(false);
    expect(isShardedRefusal(404, SHARDED)).toBe(false);
    expect(isShardedRefusal(429, SHARDED)).toBe(false);
    expect(isShardedRefusal(500, SHARDED)).toBe(false);
  });
});

describe('assertServedFile', () => {
  it('accepts the tree file whose size is the manifest model layer', () => {
    expect(() => assertServedFile(182_328_371_648, layers(182_328_371_648, ['license', 11_607]), 'hf.co/AngelSlim/Hy3-GGUF:Q4_K_M')).not.toThrow();
  });

  it("throws, naming both sizes, when the tree file is not the manifest's model layer", () => {
    expect(() => assertServedFile(184_656_950_752, layers(182_328_371_648), 'hf.co/AngelSlim/Hy3-GGUF:Q4_K_M')).toThrow(
      /hf\.co\/AngelSlim\/Hy3-GGUF:Q4_K_M.*184656950752 bytes.*182328371648-byte model/,
    );
  });

  it('compares only the model layer, so a projector or license layer cannot match or mask it', () => {
    const withProjector = layers(5_000, ['projector', 900], ['license', 11_607]);
    expect(() => assertServedFile(5_000, withProjector, 'tag')).not.toThrow();
    expect(() => assertServedFile(900, withProjector, 'tag')).toThrow();
    expect(() => assertServedFile(11_607, withProjector, 'tag')).toThrow();
  });

  it('passes with no manifest (a repo of shards, which the endpoint refuses), and fails on a manifest with no model layer', () => {
    expect(() => assertServedFile(1, undefined, 'tag')).not.toThrow();
    expect(() => assertServedFile(1, [{ mediaType: 'application/vnd.ollama.image.license', size: 1 }], 'tag')).toThrow(/no model layer/);
  });
});

describe('resolveHuggingFaceGguf', () => {
  it('sizes the row by every manifest layer and reads the file whose size is the model layer', () => {
    // Hy3: model + license. Mellum: model + template + params. Both match the generated table's fileBytes.
    const hy3 = resolveHuggingFaceGguf(HY3, 'hf.co/AngelSlim/Hy3-GGUF:Q4_K_M', 'Q4_K_M', layers(182_328_371_648, ['license', 11_607]));
    expect(hy3).toEqual({ wanted: HY3[1], fileBytes: 182_328_383_255 });
    const mellum = resolveHuggingFaceGguf(
      MELLUM,
      'hf.co/JetBrains/Mellum2.1-12B-A2.5B-Thinking-GGUF:Q4_K_M',
      'Q4_K_M',
      layers(8_071_295_264, ['template', 1_506], ['params', 99]),
    );
    expect(mellum).toEqual({ wanted: MELLUM[0], fileBytes: 8_071_296_869 });
  });

  it('counts a vision projector layer, as bartowski/NousResearch_Arete-27B-GGUF carries one', () => {
    const tree = [{ path: 'NousResearch_Arete-27B-Q4_K_M.gguf', size: 17_203_416_064 }];
    const arete = resolveHuggingFaceGguf(
      tree,
      'hf.co/bartowski/NousResearch_Arete-27B-GGUF:Q4_K_M',
      'Q4_K_M',
      layers(17_203_416_064, ['projector', 927_607_104]),
    );
    expect(arete.fileBytes).toBe(18_131_023_168);
  });

  it('keeps the size of the tree files for a repo whose manifest the endpoint refuses', () => {
    expect(resolveHuggingFaceGguf(GLM, 'hf.co/unsloth/GLM-5.2-GGUF:UD-Q4_K_XL', 'UD-Q4_K_XL', undefined).fileBytes).toBe(467_289_111_904);
  });

  it("stops when the file it would read is not the manifest's model layer", () => {
    const wrongSize = [{ path: 'Hy3-Q4_K_M.gguf', size: 184_656_950_752 }];
    expect(() =>
      resolveHuggingFaceGguf(wrongSize, 'hf.co/AngelSlim/Hy3-GGUF:Q4_K_M', 'Q4_K_M', layers(182_328_371_648, ['license', 11_607])),
    ).toThrow(/would be another file's/);
    expect(() =>
      resolveHuggingFaceGguf(HY3, 'hf.co/AngelSlim/Hy3-GGUF:Q4_K_M', 'Q4_K_M', [{ mediaType: 'application/vnd.ollama.image.license', size: 11_607 }]),
    ).toThrow(/no model layer/);
  });
});
