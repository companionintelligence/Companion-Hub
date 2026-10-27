# Agent Task Queue — CI-Hub

> Agents: pick work from `## Ready`, move to `## In Progress` when starting, and clear or block when done.
> Workflow: [docs/agent/AGENT_WORKFLOW.md](docs/agent/AGENT_WORKFLOW.md)

---

## Ready

<!-- Format: - [ ] **slug** — one-line description (owner optional) -->

- [ ] **drive-llamacpp-lmstudio** — run a real `llama-server` and a real LM Studio against the conformance harness; replace the `unmeasured` SPEC_DECODE rows and the "not measured" conformance skips with findings, and move either engine out of `chatOnly()` if it proves `/v1/completions` or `/v1/embeddings`

---

## Done (recent)

- [x] **localai-backend-and-media-routing** — LocalAI backend integration, options object in `ConfigurationService.setInferencePreferences`, generalized TTS/STT audio routing, and pool-routed GPU media workload tracking (2026-10-22, `docs/agent/sessions/2026-10-22-localai-and-media-routing.md`)
- [x] **inference-scope-and-engines** — `inference` API-key scope for external OpenAI-compatible clients, pooled model listing merges peer inventories, llama.cpp + LM Studio backends (2026-09-21, `docs/agent/sessions/2026-09-21-inference-scope-and-engines.md`)
- [x] **agentic-workflow-toolchain** — Bootstrap agent router, workflow docs, skills, bin scripts, visual/benchmark gates (2026-07-12)
