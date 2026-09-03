# GitHub Actions workflows

These workflows run without private Tailscale fleet inventories.

This repository no longer includes the multi-node fleet QA workflows (`e2e-fleet` and `app-catalog-fleet`) because they referenced private lab hosts and organization Tailscale secrets. [Issue #1210](https://github.com/companionintelligence/CI-Hub/issues/1210) tracks their removal for open-source publication. If you still need these workflows, store them in the private organization mirror or a private operations repository.

Keep signing, Cloudflare, Apple, and Azure secrets at the organization level. Keep release workflows that use these secrets private until publication.
