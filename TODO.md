# Agent Task Queue — CI-Hub

> Agents: pick work from `## Ready`, move to `## In Progress` when starting, and clear or block when done.
> Workflow: [docs/agent/AGENT_WORKFLOW.md](docs/agent/AGENT_WORKFLOW.md)

---

## Ready

<!-- Format: - [ ] **slug** — one-line description (owner optional) -->

- [ ] **drive-llamacpp-lmstudio** — run a real `llama-server` and a real LM Studio against the conformance harness; replace the `unmeasured` SPEC_DECODE rows and the "not measured" conformance skips with findings, and move either engine out of `chatOnly()` if it proves `/v1/completions` or `/v1/embeddings`
- [ ] **inference-endpoint-settings-fields** — rework `ConfigurationService.setInferencePreferences` off its eight positional parameters, then give `LLAMACPP_URL` / `LMSTUDIO_URL` (and Lucebox) Settings fields instead of environment-only config
- [ ] **pool-routed-media** — route ComfyUI image/video through the pool as an engine. Today a peer whose GPU is saturated by ComfyUI reports an empty queue, so text inference is placed on it anyway (see hub-pool.md, Known limitations)

---

## Done (recent)

- [x] **inference-scope-and-engines** — `inference` API-key scope for external OpenAI-compatible clients, pooled model listing merges peer inventories, llama.cpp + LM Studio backends (2026-09-21, `docs/agent/sessions/2026-09-21-inference-scope-and-engines.md`)

- [x] **agentic-workflow-toolchain** — Bootstrap agent router, workflow docs, skills, bin scripts, visual/benchmark gates (2026-07-12)
