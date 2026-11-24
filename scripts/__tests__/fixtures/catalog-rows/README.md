# Catalog row checker fixtures

Answers recorded on 2026-11-15 from the live registries, for the tests of `scripts/catalog/check-rows.ts`
(`catalog-row-checks.test.ts`, `catalog-row-reads.test.ts`, `catalog-check-rows.test.ts`). The tests read these files
and never the network, so they pass offline and do not change when a registry rebuilds a tag. A test states what a
fixture says (for example, that `qwen3.6:27b`'s layers add up to 17,769,076,719 bytes), not what the registry says today.

Every file comes from a plain `GET`. Nothing was pulled and no weights were downloaded.

| Folder | What it holds | How it was recorded |
|---|---|---|
| `ollama/` | A manifest and its config blob for each of `qwen3.6:27b`, `flint:40b` (NVFP4, requires 0.40.9), `gpt-oss:20b` (MXFP4), `gemma3:270m` (Q8_0), `ripple-preview:65b` (requires 0.40.16) and `glm-5.3:cloud` (a cloud proxy: no layers, a `remote_host`); and the 404 body for an unknown tag | `curl -sSL -A ci-hub-catalog-tools -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' https://registry.ollama.ai/v2/library/<model>/manifests/<tag>`, then `https://registry.ollama.ai/v2/library/<model>/blobs/<config digest>` |
| `hf-gguf/` | Hugging Face's Ollama manifests for two single-file quants (Arete 27B with its vision projector, Nanbeige 4.3 33B), and its refusals: HTTP 400 for a repo of sharded files, 400 for a quant the repo lacks, 401 for a repo that does not exist | `curl -s -A 'ollama/0.34.0 (arm64 darwin) Go/go1.24.0' -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' https://huggingface.co/v2/<repo>/manifests/<quant>` |
| `hf-repo/` | Hugging Face API records and `config.json` files for `Qwen/Qwen3-8B`, `openai/gpt-oss-20b` (a second copy of the weights under `original/`), `google/gemma-4-31B-it` (`max_position_embeddings` in `text_config`, with a different value in `vision_config`), `mlx-community/Ornith-1.5-35B-A3B-OptiQ-4bit` (5 root shards, and `optiq/` with a vision tower and a draft head, API record only), and a gated repo (`meta-llama/Llama-3.2-3B-Instruct`), plus the 401 body for a repo that does not exist | `curl -s -A ci-hub-catalog-tools 'https://huggingface.co/api/models/<repo>?blobs=true'` and `https://huggingface.co/<repo>/resolve/main/config.json` |

The API records keep only the fields the checker reads: `id`, `sha`, `gated`, `private`, `disabled`, `pipeline_tag`,
`library_name`, `lastModified`, `safetensors`, and each file's name and size. The other files are whole.

`hf-repo/nemotron-3-nano-30b-a3b-4bit.config.json.txt` is a `config.json` from `mlx-community/NVIDIA-Nemotron-3-Nano-30B-A3B-4bit`
that holds `"time_step_limit": [0.0, Infinity]`, which Python writes and `JSON.parse` refuses. It is kept as text, byte
for byte, because it is not valid JSON.

`replay.ts` loads these files and replays them as a `fetch`. It answers only the URLs a test gives it. Any other request is
recorded and fails like a network error, so it never reaches the network, and a test that lists the requests sees it.
