/**
 * Where the catalog scripts ask the model registries, and how each one wants to be asked. The generator
 * (gen-kv-geometry.ts) and the row checker (check-rows.ts) both read these, so they cannot disagree about it.
 *
 * WHY the User-Agents differ: registry.ollama.ai answers a plain agent with the manifest, and answers an `ollama/` agent
 * with HTTP 401 unless the request carries Ollama's signed token. Hugging Face's registry endpoint is the other way
 * round: it serves the Ollama-shaped manifest, and refuses a sharded repo with HTTP 400, only to a client that says it
 * is Ollama. Asking with the wrong one gives a confident wrong answer, so the pairing lives here, once.
 */

/** Sent to registry.ollama.ai and to Hugging Face's API. */
export const UA = { 'User-Agent': 'ci-hub-catalog-tools' };

/** What Ollama's pull sends to Hugging Face's registry endpoint, which answers a sharded repo with HTTP 400. */
export const OLLAMA_UA = 'ollama/0.34.0 (arm64 darwin) Go/go1.24.0';

/** The manifest type both registries serve to a pull. */
export const MANIFEST_ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json';

/** A model in Ollama's registry: `name` is `library/<model>` or `<namespace>/<model>`. */
export interface OllamaRef {
  name: string;
  tag: string;
}

/** `qwen3:8b` is `library/qwen3` at `8b`, `openbmb/minicpm-v4.7:1b` keeps its namespace, and a bare name takes `latest`. */
export function ollamaRef(tagged: string): OllamaRef {
  const colon = tagged.lastIndexOf(':');
  const [nameWithNs, tag] = colon > 0 ? [tagged.slice(0, colon), tagged.slice(colon + 1)] : [tagged, 'latest'];
  return { name: nameWithNs.includes('/') ? nameWithNs : `library/${nameWithNs}`, tag };
}

export const ollamaManifestUrl = (ref: OllamaRef): string => `https://registry.ollama.ai/v2/${ref.name}/manifests/${ref.tag}`;

export const ollamaBlobUrl = (ref: OllamaRef, digest: string): string => `https://registry.ollama.ai/v2/${ref.name}/blobs/${digest}`;

/** A Hugging Face GGUF repo and the quant tag Ollama pulls from it: `hf.co/<owner>/<repo>:<quant>`. */
export interface HfGgufRef {
  repo: string;
  quant: string;
}

export const isHfGguf = (tagged: string): boolean => tagged.startsWith('hf.co/');

export function hfGgufRef(tagged: string): HfGgufRef {
  const [repo = '', quant = ''] = tagged.slice('hf.co/'.length).split(':');
  return { repo, quant };
}

export const hfManifestUrl = (ref: HfGgufRef): string => `https://huggingface.co/v2/${ref.repo}/manifests/${ref.quant}`;
