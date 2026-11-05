# Agent Task Queue — CI-Hub

> Agents: pick work from `## Ready`, move to `## In Progress` when starting, and clear or block when done.
> Workflow: [docs/agent/AGENT_WORKFLOW.md](docs/agent/AGENT_WORKFLOW.md)

---

## Ready

<!-- Format: - [ ] **slug** — one-line description (owner optional) -->

- [ ] **drive-llamacpp-lmstudio** — run a real `llama-server` and a real LM Studio against the conformance harness; replace the `unmeasured` SPEC_DECODE rows and the "not measured" conformance skips with findings, and move either engine out of `chatOnly()` if it proves `/v1/completions` or `/v1/embeddings`
- [ ] **did-sign-in-step-up** — make linking a DID ask for the current password (or a TOTP code) the way changing the password does; a person who only signs in through Portal has no local password, so decide what they are asked for (`docs/security/hub-portal-trust.md#sign-in-with-a-did`)
- [ ] **did-sign-in-first-signer** — run the DID sign-in against a real signer: a Local.Pub account or a wallet that makes the self-issued ID token for this Hub's audience, then add the SIOPv2 request-object transport; until then nothing has ever produced a token for it outside the tests

---

## Done (recent)

- [x] **hub-did-key-sign-in** — sign in with a DID, off unless `CI_HUB_DID_AUTH=true`: five routes, link-first, no person or binding from a DID alone, TOTP kept, no AID header; needs the Hub security reviewer before merge (2026-11-05, `docs/agent/sessions/2026-11-05-hub-did-key-sign-in.md`)

- [x] **hub-workflow-hygiene** — add a workflow guard that `pnpm test` runs, name the secrets each called release workflow receives, give six workflows a read-only token, and add `SECURITY.md` (2026-10-30, `docs/agent/sessions/2026-10-30-hub-workflow-hygiene.md`)
- [x] **hub-keri-freeze** — freeze the in-tree KERI module as not interoperable, stop emitting label-derived `did:keri:` strings in forward auth, and delete a visitor's AID headers at the Traefik edge (2026-10-30, `docs/agent/sessions/2026-10-30-hub-keri-freeze.md`)
- [x] **qa-start-timeout-cleanup** — prevent unsafe QA retries after Docker start timeouts, output overflow, and external termination; verify cleanup before retries (2026-10-27, [PR #2171](https://github.com/companionintelligence/Companion-Hub/pull/2171))
- [x] **localai-backend-and-media-routing** — LocalAI backend integration, options object in `ConfigurationService.setInferencePreferences`, generalized TTS/STT audio routing, and pool-routed GPU media workload tracking (2026-10-22, `docs/agent/sessions/2026-10-22-localai-and-media-routing.md`)
- [x] **inference-scope-and-engines** — `inference` API-key scope for external OpenAI-compatible clients, pooled model listing merges peer inventories, llama.cpp + LM Studio backends (2026-09-21, `docs/agent/sessions/2026-09-21-inference-scope-and-engines.md`)
- [x] **agentic-workflow-toolchain** — Bootstrap agent router, workflow docs, skills, bin scripts, visual/benchmark gates (2026-07-12)
