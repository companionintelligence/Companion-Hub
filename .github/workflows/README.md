# GitHub Actions workflows

These workflows run without private Tailscale fleet inventories.

This repository no longer includes the multi-node fleet QA workflows (`e2e-fleet` and `app-catalog-fleet`) because they referenced private lab hosts and organization Tailscale secrets. [Issue #1210](https://github.com/companionintelligence/CI-Hub/issues/1210) tracks their removal for open-source publication. If you still need these workflows, store them in the private organization mirror or a private operations repository.

Keep signing, Cloudflare, Apple, and Azure secrets at the organization level. Keep release workflows that use these secrets private until publication.

## Workflow rules

Every workflow here runs only when you dispatch it, so a check that lives in a workflow never runs on a push. `pnpm run check:workflows` therefore runs these rules from `check:pr`, from the `Hub CI` workflow, and from the test suite (`scripts/__tests__/check-workflow-hygiene.test.ts`). It reads the workflow files as text, so it needs no dependencies.

| Rule                  | What it refuses                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dangerous-trigger`   | `pull_request_target` or `workflow_run` in the triggers, or in the commented original triggers that `ci-local restore` puts back.                            |
| `secrets-inherit`     | A job that hands every secret to the workflow it calls, in any spelling of `secrets: inherit`.                                                               |
| `secret-map`          | A call that passes other secrets than the called workflow reads, or that the called workflow does not declare under `on.workflow_call.secrets`.              |
| `missing-permissions` | A workflow with no `permissions` at the top where a job also has none.                                                                                       |
| `private-key`         | A private-key block in a tracked text file.                                                                                                                  |
| `unpinned-uses`       | An action reference that can move: a tag, a branch, or a commit with no comment that names the release. The guard lists these but does not fail on them yet. |
| `allow-list`          | A malformed `.github/workflow-hygiene.allow.json`, or an entry in it that no longer matches anything.                                                        |

Comments are ignored, and so is the text of a block scalar such as `run: |`. The one exception is `dangerous-trigger`, which also reads the commented original triggers. The guard reports a shape it cannot read, such as a job written in flow style or built with a merge key (`<<:`), or an alias in the triggers, instead of passing it. It counts every `secrets.NAME` in a called workflow as a read, whether or not an expression wraps it. Run `pnpm run check:workflows --report` to list the `unpinned-uses` findings.

### Pass secrets by name

A job that calls a reusable workflow passes the secrets that workflow reads, by name:

```yaml
jobs:
  build-container:
    uses: ./.github/workflows/build-container.yml
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

The called workflow declares the same names under `on.workflow_call.secrets` and accepts no others. Don't write `secrets: inherit`: it gives the called workflow every secret of the calling one, including the signing secrets of a release workflow. When you add `secrets.NAME` to a called workflow, declare the name there and pass it from every caller, or `secret-map` fails.

`ci-local restore` replaces the active `on:` block with the commented original. Before you restore a workflow that declares `on.workflow_call.secrets`, copy the declaration into the commented original, or the restore drops it and its callers stop starting.

### Allow-list

`.github/workflow-hygiene.allow.json` lists what the guard accepts, under `secretsInherit`, `pem`, and `missingPermissions`. Each entry names a file, optionally a job, and a reason of at least eight characters. The list can only shrink: an entry that no longer matches anything fails the check, so remove it when you fix what it covered.

It holds four jobs in the release workflows that call a reusable workflow and set no `permissions` of their own. A calling job can only lower the token the called workflow gets, and these workflows publish images, releases, and packages, so narrow them only after a dispatch rehearsal.
