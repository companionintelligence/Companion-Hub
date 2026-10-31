> **Purpose:** Define how third-party agent images are adapted safely to CI Hub and its Marketplace.
> **Scope:** Marketplace manifests, app proxy/auth boundaries, agent containers, persistent state.
> **Key paths:** packages/backend/src/modules/app-lifecycle, packages/backend/src/modules/inference/app-credentials.service.ts, CI-Marketplace/apps/openclaw, CI-Marketplace/apps/hermes-agent
> **Commands:** bin/agent-review --phase research --persona security; run targeted Marketplace QA before promotion.
> **Owner persona:** security
> **Last updated:** 2026-10-30
> **Related:** agent-qa.md, backend.md, ../agent/AGENT_WORKFLOW.md

## Platform adapters do not transfer between app stores

An app image can carry platform-specific assumptions that are not visible in its upstream project's name. Review the wrapper, manifest, and ingress together before importing an image. The rows below compare two reference app stores, called store A and store B.

| Source | Trust and runtime model | CI Hub adaptation |
|---|---|---|
| Store A OpenClaw | Its wrapper warns that it is only secure behind the store A app proxy. It binds the Gateway to loopback, rewrites Gateway auth to store A trusted-proxy identity, and removes a shared token. | CI Marketplace's adapter sets Hub inference and a token, but the pinned wrapper later replaces that auth and expects store A identity headers. Hub does not provide those headers. The upstream listing is quarantined in dev until it uses a Hub-owned wrapper or upstream image and passes runtime QA. Prefer CI-OpenClaw meanwhile. |
| Store A Hermes | Its wrapper disables Hermes dashboard login under the assumption that store A's proxy is the only public auth boundary. | Keep CI's app-native dashboard credentials or add a reviewed CI-owned proxy adapter. Never set the store A proxy-auth variable in a CI image without implementing and verifying the same trust boundary. |
| Store B OpenClaw | Its [OAC package](https://github.com/beclab/apps/tree/main/clawdbot) provisions a random Gateway token, an origin allowlist, trusted proxy ranges, internal entrances, and explicit opt-ins for home and external directory access. The current chart sets sandbox mode to off even though it names a Docker sandbox backend. | Translate permissions and runtime behavior into CI Marketplace forms and Hub Compose. Do not equate a container boundary or configured sandbox backend with an active in-agent sandbox. |
| Store B Hermes | Its [OAC package](https://github.com/beclab/apps/tree/main/hermesagent) keeps dashboard/terminal entrances internal, leaves the API disabled until keyed, and defaults broad file access and all-sender messaging off. | Keep agent APIs private and keyed, make host-data access explicit, and default messaging to an allowlist. |

Store B's application charts are platform-specific. Port the upstream app and the reviewed behavior, not the chart or its permissions wholesale.

## Hub and Marketplace integration contract

- The generic Hermes listing uses Hub's app-credentials flow to receive the selected local or cloud model configuration. Hub still supports OpenClaw credentials, but the current Marketplace image wrapper prevents that listing from using them correctly. The supported slugs and environment mappings live in packages/backend/src/modules/inference/app-credentials.service.ts.
- CI-native CI-OpenClaw and CI-Hermes are separate builds. Their manifests declare Hub inference, Companion Memory, MCP, and edge-auth integration where supported.
- Default Hub forward authentication for browser-only routes. If the app shares its hostname with external webhooks or OAuth callbacks, keep app-native auth and do not enable whole-host Hub auth by default until callback behavior or path exclusions are verified.
- Keep Gateway and OpenAI-compatible API ports off the host. Internal clients must use per-install API keys.
- For Hermes, default GATEWAY_ALLOW_ALL_USERS to false and require explicit GATEWAY_ALLOWED_USERS unless an operator deliberately opens messaging access.
- Persist app state in the app's data directory. Mount home or external directories only after a deliberate operator choice.
- Describe container isolation and agent command sandboxing separately. An image may have a dedicated container while its internal sandbox is off.

## OpenClaw bootstrap source of truth

The Hub install pipeline first copies the CI Marketplace app payload. Its local fallback is used only if the payload does not include a bootstrap script. The OpenClaw adapter therefore exists in both:

- Companion-Hub: packages/backend/src/modules/app-lifecycle/data/openclaw-ci-entrypoint.sh
- CI-Marketplace: apps/openclaw/data/ci-entrypoint.sh

Keep these files synchronized in one cross-repository change. The Hub copy currently contains active-backend model sync, context-window limits, and cloud-provider registration; an older Marketplace copy can silently discard those capabilities at install time. They are synchronized in this update.

The pinned Marketplace image is OpenClaw 2026.9.2-2. Its startup server overwrites the adapter's auth config with store A trusted-proxy mode, deletes the generated Gateway token, and expects a store A identity header. The app is quarantined until that wrapper is replaced or adapted. Its adapter also carries legacy Control UI compatibility flags. Store B's newer chart documents that OpenClaw 2026.9.6 removed the device-auth bypass and uses normal pairing. Revisit those flags with the next image upgrade, then verify local access, Hub-authenticated exposure, pairing, token authentication, and app restart.

## Promotion gate

Static manifest validation is not runtime QA. Before promoting an agent app, verify authentication through every route, direct-port behavior, sender allowlists, provider and memory setup, state persistence, update behavior, backup/restore, and any optional host-data permission on a real Hub.
