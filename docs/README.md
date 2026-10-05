# Documentation map

User documentation lives at **[docs.ci.computer](https://docs.ci.computer)**: installation, tutorials, connecting agents, networking, and reference. Send people who run a Hub there. This directory holds the engineering notes that change with this repository's code.

Use this index so Hub, Portal, Memory, and agent-only material stay distinct.

## Product names

| Name | What it is | Open source? |
|------|------------|--------------|
| **Companion Hub** (this repo) | Appliance runtime: installs and supervises marketplace apps | Yes (PolyForm Noncommercial) |
| **Companion Portal** | Cloud control plane (entitlements, device registration, OIDC) | No |
| **Companion Memory** (CI-Server / ci-memory) | Personal memory brain on the appliance | Yes (PolyForm Noncommercial) |

Do not call Hub “CI-OS-Hub”, “Runtipi”, or “Tipi” in new docs. Prefer **Companion Hub** or **Hub**. Prefer **Companion Memory** over CI-Server in user-facing prose; keep `ci-memory` for compose service and package names.

## Tip scrub policy

Before publish, tip content may include **people and device names** (for example `core-2`, `beta-1`, operator display names).

Do **not** commit:

- Private or lab **URLs** (real MagicDNS suffixes, Tailscale Serve hostnames, internal Drive/wiki URLs that are not public product links)
- Live **Tailscale CGNAT addresses** from the lab (use documentation examples such as `100.64.0.1`)
- **Passwords**, API keys, tokens, or private key material (test fixtures must use obvious placeholders)

Public product URLs (`https://ci.computer`, `https://hub.ci.computer`, `*.companionintelligence.com` as documented product surfaces) and support addresses (`support@companionintelligence.com`) are fine.

## Writing style

Follow the [Google developer documentation style guide](https://developers.google.com/style) and the house summary in [`writing-style.md`](writing-style.md). Apply the same voice to English prose in markdown **and** to comments meant for humans (not generated code or schemas).

## Where to look

### Start here

| Doc | Audience |
|-----|----------|
| [docs.ci.computer](https://docs.ci.computer) | Anyone installing or running a Hub |
| [`../README.md`](../README.md) | Anyone cloning the repo |
| [`DEVELOPMENT_SETUP.md`](DEVELOPMENT_SETUP.md) | Prerequisites, the two installs that fail without them, and known-good test baselines |
| [`License-FAQ.md`](License-FAQ.md) | License questions |
| [`security/hub-portal-trust.md`](security/hub-portal-trust.md) | Hub ↔ Portal trust; marketplace needs a paired device key |
| [`portal-check-in.md`](portal-check-in.md) | Portal check-in, reading registration health without sending one, and recovering a Hub whose device key Portal rejects |
| [`telemetry.md`](telemetry.md) | What Hub reports to Sentry, and the switches that stop it |
| [`CLI.md`](CLI.md) | `cihub` CLI |
| [`editor-inference.md`](editor-inference.md) | Point Continue, Zed, Cline, Aider, or an OpenAI SDK at the Hub: base URL, `inference` key, and model |
| [`hub-stack-self-update.md`](hub-stack-self-update.md) | What the Hub self-updater moves and refuses, and how to turn off auto-update on a node |
| [`fleet-setup.md`](fleet-setup.md) | End-to-end setup: account, devices, operators, tailnet, and pooling — the order to do them in |
| [`private-vpn.md`](private-vpn.md) | Tailscale private VPN |
| [`hub-pool.md`](hub-pool.md) | Multi-Hub inference pooling over Tailscale |
| [`inference-supervision.md`](inference-supervision.md) | Observing inference backends and Compose-wide crash loops — and why the Hub never restarts one |
| [`inference-engine-comparison.md`](inference-engine-comparison.md) | Ollama, vLLM, Lemonade, and oMLX compared with the Strix Halo engines Halogen and Gufo, and what a fair test needs |
| [`hub-pool-fleet-testing.md`](hub-pool-fleet-testing.md) | Two-node validation plan for Hub Pool |
| [`hub-pool-vs-pair.md`](hub-pool-vs-pair.md) | Hub Pool compared with NVIDIA Personal-AI-Router |
| [`fleet-router.md`](fleet-router.md) | Prompt every tailnet inference node when no Hub can run |
| [`openclaw-test-account.md`](openclaw-test-account.md) | Isolated OpenClaw profile routed across the fleet |
| [`runbooks/fleet-pool-upgrade.md`](runbooks/fleet-pool-upgrade.md) | Release and roll out a pool-capable Hub to the fleet |
| [`ci-cd-pipeline.md`](ci-cd-pipeline.md) | Historical multi-env deploy notes |
| [`dns-cache-analysis.md`](dns-cache-analysis.md) | Desktop DNS NXDOMAIN investigation |

### Architecture (Hub)

| Doc | Role |
|-----|------|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Deep dive for this repo |
| [`PLATFORM_ARCHITECTURE.md`](PLATFORM_ARCHITECTURE.md) | How Hub sits next to Portal and Memory |
| [`system/`](system/) | Living subsystem notes agents update with code |

`packages/backend/ARCHITECTURE.md` is a short pointer only; do not treat it as the source of truth.

### Testing and QA

| Doc | Role |
|-----|------|
| [`E2E_TESTING_STRATEGY.md`](E2E_TESTING_STRATEGY.md) | Playwright / e2e strategy |
| [`MCP_TESTING_STRATEGY.md`](MCP_TESTING_STRATEGY.md) | Marketplace MCP QA |
| [`FLYWHEEL.md`](FLYWHEEL.md) | App explorer flywheel (lab passwords are placeholders) |
| [`../e2e/README.md`](../e2e/README.md) | Local e2e commands |
| [`hub-pool-fleet-testing.md`](hub-pool-fleet-testing.md) | Manual two-node Hub Pool validation on real appliances |

Multi-node fleet orchestration lives on a **private** ops mirror, not in this tip.

### Agent and contributor process

| Doc | Role |
|-----|------|
| [`../AGENTS.md`](../AGENTS.md) | Agent router |
| [`agent/`](agent/) | Workflow, review, coding conventions |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | Human contributor guide |

Session dumps and audits are **not** published on the tip (`agent/sessions/`, `audits/` are stubs).

### Video

| Path | Role |
|------|------|
| [`../video/`](../video/) | Active HyperFrames build |
| [`../videos/`](../videos/) | Archived tutorial assets |

Prefer `video/` for new work. Do not mix the two trees without updating both READMEs.
