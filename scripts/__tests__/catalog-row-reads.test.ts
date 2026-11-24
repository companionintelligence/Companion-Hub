import { describe, expect, it } from 'vitest';
import { hfGgufRef, hfManifestUrl, MANIFEST_ACCEPT, OLLAMA_UA, ollamaRef, UA } from '../catalog/registry-endpoints';
import {
  MAX_BODY_BYTES,
  type ReadDeps,
  ReadFailed,
  type HfModel,
  readHfGgufManifest,
  readHfRepo,
  readOllamaRegistry,
  readReply,
  retryDelayMs,
} from '../catalog/row-reads';
import { answer, type Call, fixture, fixtureJson, ollama, replay } from './fixtures/catalog-rows/replay';

/** The reads against recorded answers: which URLs they ask for, with which headers, how they retry, and that they never fetch weights. */

const deps = (fetch: ReadDeps['fetch']): ReadDeps & { sleeps: number[] } => {
  const sleeps: number[] = [];
  return {
    fetch,
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
};

const onlyGets = (calls: Call[]) => expect(calls.map((c) => c.method)).toEqual(calls.map(() => 'GET'));

describe('registry endpoints', () => {
  it('puts a bare model in the library namespace, keeps a namespace, and takes latest when there is no tag', () => {
    expect(ollamaRef('qwen3.6:27b')).toEqual({ name: 'library/qwen3.6', tag: '27b' });
    expect(ollamaRef('openbmb/minicpm-v4.7:1b')).toEqual({ name: 'openbmb/minicpm-v4.7', tag: '1b' });
    expect(ollamaRef('laguna-s-2.1')).toEqual({ name: 'library/laguna-s-2.1', tag: 'latest' });
    expect(ollamaRef('frob/deepseek-v4-flash-0731:284b-a13b-ud-q4_k_xl').tag).toBe('284b-a13b-ud-q4_k_xl');
  });

  it('splits an hf.co reference into its repo and quant', () => {
    expect(hfGgufRef('hf.co/unsloth/GLM-5.2-GGUF:UD-Q4_K_XL')).toEqual({ repo: 'unsloth/GLM-5.2-GGUF', quant: 'UD-Q4_K_XL' });
    expect(hfManifestUrl({ repo: 'unsloth/GLM-5.2-GGUF', quant: 'UD-Q4_K_XL' })).toBe(
      'https://huggingface.co/v2/unsloth/GLM-5.2-GGUF/manifests/UD-Q4_K_XL',
    );
  });

  it('keeps the two agents apart: Ollama registry takes a plain one, and the Hugging Face endpoint must be told it is Ollama', () => {
    expect(UA['User-Agent']).not.toMatch(/ollama\//i);
    expect(OLLAMA_UA).toMatch(/^ollama\/\d+\.\d+\.\d+ /);
  });
});

describe('readOllamaRegistry', () => {
  const ref = ollamaRef('flint:40b');
  const manifestUrl = ollama.manifest('library/flint', '40b');
  // The digests in the recorded manifest: the config blob, and the 22.8 GB model layer that must never be requested.
  const configDigest = 'sha256:04d6796ac4f18613fecb301ecf5a519bf8f660ad1e6808d56240ad1f19e69e44';
  const modelDigest = 'sha256:97cc8009ff9b132d5cf3c488e6767962bb5a5dc158a90ed661bbbddf876b8bde';

  it('asks for the manifest as a pull does, then reads the config blob and nothing else', async () => {
    const { fetch, calls } = replay({
      [manifestUrl]: answer(200, fixture('ollama/flint-40b.manifest.json')),
      [ollama.blob('library/flint', configDigest)]: answer(200, fixture('ollama/flint-40b.config.json')),
    });
    const read = await readOllamaRegistry(ref, deps(fetch));
    expect(read.ok && read.value.config).toMatchObject({ file_type: 'NVFP4', requires: '0.40.9' });
    expect(read.ok && read.value.manifest.layers).toHaveLength(4);
    expect(calls.map((c) => c.url)).toEqual([manifestUrl, ollama.blob('library/flint', configDigest)]);
    expect(calls[0]?.headers).toEqual({ 'User-Agent': 'ci-hub-catalog-tools', Accept: MANIFEST_ACCEPT });
    expect(calls.some((c) => c.url.includes(modelDigest))).toBe(false);
    onlyGets(calls);
  });

  it('reports a tag the registry does not know as a refusal with its words, and reads no blob', async () => {
    const { fetch, calls } = replay({ [ollama.manifest('library/qwen3.6', 'not-a-tag')]: answer(404, fixture('ollama/not-a-tag.404.json')) });
    const read = await readOllamaRegistry(ollamaRef('qwen3.6:not-a-tag'), deps(fetch));
    expect(read).toEqual({ ok: false, status: 404, message: 'manifest unknown' });
    expect(calls).toHaveLength(1);
  });

  it('reports a manifest that names no config blob as unread, since nothing can be said of the row', async () => {
    const { fetch } = replay({ [manifestUrl]: answer(200, '{"layers":[]}') });
    await expect(readOllamaRegistry(ref, deps(fetch))).rejects.toBeInstanceOf(ReadFailed);
  });
});

describe('readHfGgufManifest', () => {
  const ref = hfGgufRef('hf.co/unsloth/GLM-5.2-GGUF:UD-Q4_K_XL');
  const url = hfManifestUrl(ref);

  it('asks as Ollama asks, because Hugging Face answers a sharded repo only to a client that says it is Ollama', async () => {
    const { fetch, calls } = replay({ [url]: answer(400, fixture('hf-gguf/glm-5.2-sharded.400.json')) });
    const read = await readHfGgufManifest(ref, deps(fetch));
    expect(calls[0]?.headers).toEqual({ 'User-Agent': OLLAMA_UA, Accept: MANIFEST_ACCEPT });
    expect(read.ok).toBe(false);
    expect(!read.ok && read.status).toBe(400);
    expect(!read.ok && read.message).toContain('only contains sharded GGUF files');
  });

  it('returns the manifest of a single-file quant', async () => {
    const arete = hfGgufRef('hf.co/bartowski/NousResearch_Arete-27B-GGUF:Q4_K_M');
    const { fetch } = replay({ [hfManifestUrl(arete)]: answer(200, fixture('hf-gguf/arete-27b.manifest.json')) });
    const read = await readHfGgufManifest(arete, deps(fetch));
    expect(read.ok && read.value.layers?.map((l) => l.mediaType?.split('.').pop())).toEqual(['model', 'projector']);
  });
});

describe('readHfRepo', () => {
  const apiUrl = 'https://huggingface.co/api/models/Qwen/Qwen3-8B?blobs=true';
  const api = fixtureJson<HfModel>('hf-repo/qwen3-8b.api.json');
  const configUrl = `https://huggingface.co/Qwen/Qwen3-8B/resolve/${api.sha}/config.json`;

  it('reads the API record with file sizes, then config.json at the commit the record came from', async () => {
    const { fetch, calls } = replay({
      [apiUrl]: answer(200, fixture('hf-repo/qwen3-8b.api.json')),
      [configUrl]: answer(200, fixture('hf-repo/qwen3-8b.config.json')),
    });
    const read = await readHfRepo('Qwen/Qwen3-8B', deps(fetch));
    expect(read.ok && read.value.model.gated).toBe(false);
    expect(read.ok && read.value.config?.max_position_embeddings).toBe(40_960);
    expect(calls.map((c) => c.url)).toEqual([apiUrl, configUrl]);
    expect(calls[0]?.headers).toEqual({ 'User-Agent': 'ci-hub-catalog-tools' });
    onlyGets(calls);
  });

  it('stops at the API record for a gated repo, whose files would answer 401', async () => {
    const { fetch, calls } = replay({
      'https://huggingface.co/api/models/meta-llama/Llama-3.2-3B-Instruct?blobs=true': answer(200, fixture('hf-repo/llama-3.2-3b-instruct.api.json')),
    });
    const read = await readHfRepo('meta-llama/Llama-3.2-3B-Instruct', deps(fetch));
    expect(read.ok && read.value.model.gated).toBe('manual');
    expect(read.ok && read.value.config).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('reports a repo Hugging Face answers 401 for, with its words', async () => {
    const { fetch } = replay({
      'https://huggingface.co/api/models/no-such-owner-xyz/no-such-repo?blobs=true': answer(401, fixture('hf-repo/missing.401.json')),
    });
    expect(await readHfRepo('no-such-owner-xyz/no-such-repo', deps(fetch))).toEqual({
      ok: false,
      status: 401,
      message: 'Invalid username or password.',
    });
  });

  it('keeps going without a config.json, and says what the request answered', async () => {
    const { fetch } = replay({
      [apiUrl]: answer(200, fixture('hf-repo/qwen3-8b.api.json')),
      [configUrl]: answer(404, '{"error":"Entry not found"}'),
    });
    const read = await readHfRepo('Qwen/Qwen3-8B', deps(fetch));
    expect(read.ok && read.value.config).toBeUndefined();
    expect(read.ok && read.value.configStatus).toBe(404);
  });

  it('reads a config.json that Python wrote with a bare Infinity, as mlx-community/NVIDIA-Nemotron-3-Nano-30B-A3B-4bit has', async () => {
    const text = fixture('hf-repo/nemotron-3-nano-30b-a3b-4bit.config.json.txt');
    expect(() => JSON.parse(text)).toThrow();
    const { fetch } = replay({ [apiUrl]: answer(200, fixture('hf-repo/qwen3-8b.api.json')), [configUrl]: answer(200, text) });
    const read = await readHfRepo('Qwen/Qwen3-8B', deps(fetch));
    expect(read.ok && read.value.config?.max_position_embeddings).toBe(262_144);
  });

  it('reads NaN and -Infinity the same way, and leaves the numbers around them alone', async () => {
    const text = '{"clip": [-Infinity, NaN, Infinity], "max_position_embeddings": 4096}';
    const { fetch } = replay({ [apiUrl]: answer(200, fixture('hf-repo/qwen3-8b.api.json')), [configUrl]: answer(200, text) });
    const read = await readHfRepo('Qwen/Qwen3-8B', deps(fetch));
    expect(read.ok && read.value.config).toEqual({ clip: [null, null, null], max_position_embeddings: 4096 });
  });

  it('reports a persistent 5xx on config.json as unread, not as a repo with no config.json, and reads on after a 429', async () => {
    const down = replay({ [apiUrl]: answer(200, fixture('hf-repo/qwen3-8b.api.json')), [configUrl]: answer(503, '') });
    await expect(readHfRepo('Qwen/Qwen3-8B', deps(down.fetch))).rejects.toThrow(/HTTP 503 from https:\/\/huggingface\.co\/Qwen\/Qwen3-8B\/resolve\//);
    let asked = 0;
    const limited = replay({
      [apiUrl]: answer(200, fixture('hf-repo/qwen3-8b.api.json')),
      [configUrl]: () => (++asked === 1 ? answer(429, '', { 'retry-after': '1' }) : answer(200, fixture('hf-repo/qwen3-8b.config.json'))),
    });
    const read = await readHfRepo('Qwen/Qwen3-8B', deps(limited.fetch));
    expect(read.ok && read.value.config?.max_position_embeddings).toBe(40_960);
  });

  it('reports a config.json that is not JSON at all as unread, not as a repo without a context window', async () => {
    const { fetch } = replay({
      [apiUrl]: answer(200, fixture('hf-repo/qwen3-8b.api.json')),
      [configUrl]: answer(200, '<html>Service Unavailable</html>'),
    });
    await expect(readHfRepo('Qwen/Qwen3-8B', deps(fetch))).rejects.toBeInstanceOf(ReadFailed);
  });
});

describe('retries', () => {
  const url = 'https://registry.ollama.ai/v2/library/x/manifests/1b';
  const sequence = (...answers: (Response | Error)[]) => {
    const calls: Call[] = [];
    const fetch: ReadDeps['fetch'] = async (u, init) => {
      calls.push({ url: u, method: init?.method ?? 'GET', headers: {} });
      const next = answers.shift();
      if (next === undefined) throw new Error('more requests than the test expected');
      if (next instanceof Error) throw next;
      return next;
    };
    return { fetch, calls };
  };

  it('waits out an exhausted Hugging Face rate-limit window, for as long as the header says, then reads again', async () => {
    const limited = answer(429, '{"error":"rate limited"}', { ratelimit: '"api";r=0;t=2', 'ratelimit-policy': '"fixed window";"api";q=500;w=300' });
    const { fetch, calls } = sequence(limited, answer(200, '{"ok":true}'));
    const d = deps(fetch);
    expect((await readReply(url, {}, d)).status).toBe(200);
    expect(d.sleeps).toEqual([2000]);
    expect(calls).toHaveLength(2);
  });

  it('backs off 1 s, then 2 s, from a 5xx with no hint, and reads on the third attempt', async () => {
    const { fetch } = sequence(answer(503, ''), answer(502, ''), answer(200, '{}'));
    const d = deps(fetch);
    expect((await readReply(url, {}, d)).status).toBe(200);
    expect(d.sleeps).toEqual([1000, 2000]);
  });

  it('returns the last 5xx when every attempt got one, and the read then reports the row as unread', async () => {
    const { fetch, calls } = sequence(answer(503, 'a'), answer(503, 'b'), answer(503, 'c'));
    const d = deps(fetch);
    expect((await readReply(url, {}, d)).status).toBe(503);
    expect(calls).toHaveLength(3);
    const again = sequence(answer(503, ''), answer(503, ''), answer(503, ''));
    await expect(readOllamaRegistry(ollamaRef('x:1b'), deps(again.fetch))).rejects.toThrow(
      /HTTP 503 from https:\/\/registry\.ollama\.ai\/v2\/library\/x\/manifests\/1b/,
    );
  });

  it('retries an HTTP 500 like any other 5xx, so a server error is an unread row and not a failed one', async () => {
    const down = sequence(answer(500, ''), answer(500, ''), answer(500, ''));
    expect((await readReply(url, {}, deps(down.fetch))).status).toBe(500);
    expect(down.calls).toHaveLength(3);
    const again = sequence(answer(500, ''), answer(500, ''), answer(500, ''));
    await expect(readOllamaRegistry(ollamaRef('x:1b'), deps(again.fetch))).rejects.toBeInstanceOf(ReadFailed);
  });

  it('waits for a Retry-After of exactly 30 seconds, and not for 31', async () => {
    const exact = sequence(answer(429, '', { 'retry-after': '30' }), answer(200, '{}'));
    const d = deps(exact.fetch);
    expect((await readReply(url, {}, d)).status).toBe(200);
    expect(d.sleeps).toEqual([30_000]);
    const over = sequence(answer(429, '', { 'retry-after': '31' }));
    const e = deps(over.fetch);
    expect((await readReply(url, {}, e)).status).toBe(429);
    expect(e.sleeps).toEqual([]);
  });

  it('honours Retry-After, and gives up on one longer than it will wait', async () => {
    const short = sequence(answer(429, '', { 'retry-after': '3' }), answer(200, '{}'));
    const d = deps(short.fetch);
    await readReply(url, {}, d);
    expect(d.sleeps).toEqual([3000]);

    const long = sequence(answer(429, '', { 'retry-after': '120' }));
    const e = deps(long.fetch);
    expect((await readReply(url, {}, e)).status).toBe(429);
    expect(e.sleeps).toEqual([]);
  });

  it('retries a network error and reports the row unread when every attempt fails', async () => {
    const flaky = sequence(new Error('socket hang up'), answer(200, '{}'));
    expect((await readReply(url, {}, deps(flaky.fetch))).status).toBe(200);

    const down = sequence(new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('ECONNRESET'));
    const d = deps(down.fetch);
    await expect(readReply(url, {}, d)).rejects.toThrow(/ECONNRESET from https:\/\/registry\.ollama\.ai.* \(3 attempts\)/);
    expect(d.sleeps).toEqual([1000, 2000]);
  });

  it('does not retry an answer that is final: 400, 401, 404', async () => {
    for (const status of [400, 401, 404]) {
      const once = sequence(answer(status, '{}'));
      const d = deps(once.fetch);
      expect((await readReply(url, {}, d)).status).toBe(status);
      expect(once.calls).toHaveLength(1);
      expect(d.sleeps).toEqual([]);
    }
  });

  it('reads the wait from the headers each server uses', () => {
    const headers = (h: Record<string, string>) => new Headers(h);
    expect(retryDelayMs(headers({ 'retry-after': '7' }), 0)).toBe(7000);
    expect(retryDelayMs(headers({ ratelimit: '"api";r=0;t=45' }), 0)).toBe(45_000);
    expect(retryDelayMs(headers({ ratelimit: '"api";r=495;t=277' }), 1)).toBe(2000);
    expect(retryDelayMs(headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }), 2)).toBe(4000);
    expect(retryDelayMs(headers({}), 0)).toBe(1000);
  });
});

describe('answers of the wrong shape', () => {
  const manifestUrl = ollama.manifest('library/flint', '40b');
  const configUrl = ollama.blob('library/flint', 'sha256:04d6796ac4f18613fecb301ecf5a519bf8f660ad1e6808d56240ad1f19e69e44');
  const apiUrl = 'https://huggingface.co/api/models/Qwen/Qwen3-8B?blobs=true';
  const hfConfigUrl = `https://huggingface.co/Qwen/Qwen3-8B/resolve/${fixtureJson<HfModel>('hf-repo/qwen3-8b.api.json').sha}/config.json`;

  it.each(['null', '[]', '"text"', '42'])('reports a 200 whose JSON is %s as unread, on every read', async (body) => {
    const flint = (manifest: string, config: string) => replay({ [manifestUrl]: answer(200, manifest), [configUrl]: answer(200, config) });
    await expect(readOllamaRegistry(ollamaRef('flint:40b'), deps(flint(body, '{}').fetch))).rejects.toThrow('JSON that is not an object');
    await expect(readOllamaRegistry(ollamaRef('flint:40b'), deps(flint(fixture('ollama/flint-40b.manifest.json'), body).fetch))).rejects.toThrow(
      'JSON that is not an object',
    );
    const arete = hfGgufRef('hf.co/bartowski/NousResearch_Arete-27B-GGUF:Q4_K_M');
    await expect(readHfGgufManifest(arete, deps(replay({ [hfManifestUrl(arete)]: answer(200, body) }).fetch))).rejects.toThrow(
      'JSON that is not an object',
    );
    await expect(readHfRepo('Qwen/Qwen3-8B', deps(replay({ [apiUrl]: answer(200, body) }).fetch))).rejects.toThrow('JSON that is not an object');
    const config = replay({ [apiUrl]: answer(200, fixture('hf-repo/qwen3-8b.api.json')), [hfConfigUrl]: answer(200, body) });
    await expect(readHfRepo('Qwen/Qwen3-8B', deps(config.fetch))).rejects.toThrow('JSON that is not an object');
  });

  it('does not print what a storage host answers a refusal with, because an S3-style error echoes the signing credential', async () => {
    const storage = (): Response => {
      const res = new Response('<Error><Code>SignatureDoesNotMatch</Code><AWSAccessKeyId>AKIAEXAMPLE0KEY</AWSAccessKeyId></Error>', { status: 403 });
      Object.defineProperty(res, 'url', { value: 'https://abc123.r2.cloudflarestorage.com/ollama/blobs/sha256/04/data?X-Amz-Signature=secret' });
      return res;
    };
    const { fetch } = replay({ [manifestUrl]: answer(200, fixture('ollama/flint-40b.manifest.json')), [configUrl]: storage });
    const read = await readOllamaRegistry(ollamaRef('flint:40b'), deps(fetch));
    expect(read).toEqual({ ok: false, status: 403, message: '' });
    expect(JSON.stringify(read)).not.toContain('AKIA');
  });
});

describe('read-only', () => {
  it('refuses a body longer than a manifest or a config could be, and stops reading it', async () => {
    let pulled = 0;
    let cancelled = false;
    const weights = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const url = 'https://registry.ollama.ai/v2/library/x/blobs/sha256:00';
    const { fetch } = replay({ [url]: () => new Response(weights, { status: 200 }) });
    await expect(readReply(url, {}, deps(fetch))).rejects.toThrow(/refusing a body over 5242880 bytes/);
    expect(MAX_BODY_BYTES).toBe(5 * 1024 * 1024);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it('makes only GET requests, and no request for a layer of a model, across a whole run of every kind of row', async () => {
    const { fetch, calls } = replay({
      [ollama.manifest('library/gpt-oss', '20b')]: answer(200, fixture('ollama/gpt-oss-20b.manifest.json')),
      [ollama.blob('library/gpt-oss', fixtureJson<{ config: { digest: string } }>('ollama/gpt-oss-20b.manifest.json').config.digest)]: answer(
        200,
        fixture('ollama/gpt-oss-20b.config.json'),
      ),
      [hfManifestUrl({ repo: 'bartowski/NousResearch_Arete-27B-GGUF', quant: 'Q4_K_M' })]: answer(200, fixture('hf-gguf/arete-27b.manifest.json')),
      'https://huggingface.co/api/models/Qwen/Qwen3-8B?blobs=true': answer(200, fixture('hf-repo/qwen3-8b.api.json')),
      [`https://huggingface.co/Qwen/Qwen3-8B/resolve/${fixtureJson<HfModel>('hf-repo/qwen3-8b.api.json').sha}/config.json`]: answer(
        200,
        fixture('hf-repo/qwen3-8b.config.json'),
      ),
    });
    const d = deps(fetch);
    await readOllamaRegistry(ollamaRef('gpt-oss:20b'), d);
    await readHfGgufManifest(hfGgufRef('hf.co/bartowski/NousResearch_Arete-27B-GGUF:Q4_K_M'), d);
    await readHfRepo('Qwen/Qwen3-8B', d);
    expect(calls).toHaveLength(5);
    onlyGets(calls);
    // A weights blob is addressed by a digest under /blobs/: the only blob asked for is the one-line config.
    const blobs = calls.filter((c) => c.url.includes('/blobs/'));
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.url).toContain(fixtureJson<{ config: { digest: string } }>('ollama/gpt-oss-20b.manifest.json').config.digest);
    expect(calls.some((c) => /\.safetensors|\.gguf/.test(c.url))).toBe(false);
  });
});
