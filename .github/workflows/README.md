# GitHub Actions in this repository

Workflows here are meant to run without private Tailscale fleet inventories.

Multi-node fleet QA (`e2e-fleet`, `app-catalog-fleet`) lived in this repo historically and named private lab hosts plus org Tailscale secrets. Those workflow files are **removed from the tip** for open-source readiness (companionintelligence/CI-Hub#1210). Keep copies on the private org mirror or a private ops repo if you still need them.

Signing, Cloudflare, and Apple/Azure secrets remain org-side for release workflows that stay private until publish.
