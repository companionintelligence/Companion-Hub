# Security policy

This policy covers Companion Hub, the code in this repository.

## Report a vulnerability

Report it privately. Don't open a public issue, pull request, or discussion about it, and don't post details in a chat.

Use GitHub's private vulnerability reporting: open the **Security** tab of this repository, choose **Report a vulnerability**, and describe what you found. Only the maintainers can read the report.

If you can't use that form, write to the support address, `support@companionintelligence.com` (it is also listed in [`docs/README.md`](docs/README.md)), and ask for a private channel. Say only that you have a security report and how to reach you, and send the details after a maintainer replies.

## What to include

Say what you found, which release or commit you tested, and how to reproduce it. Don't put credentials, tokens, private keys, or other people's personal data in a report. If you hold something that proves the problem, describe it instead of attaching it.

## Supported versions

Fixes go into the latest release and into `dev`. Update to the latest release to get them.

## Scope

In scope:

- The Hub backend and its API.
- The desktop and mobile apps.
- The `cihub` command line.
- The Docker Compose files and Traefik configuration that Hub ships.

Out of scope:

- Companion Portal and Companion Memory, which are separate products.
- Apps in the marketplace. Other people write them, so report a problem in an app to its author.
- A Hub that its operator has modified. Whoever runs the appliance controls it, and [`docs/security/hub-portal-trust.md`](docs/security/hub-portal-trust.md) already treats a modified Hub as an untrusted client of Portal.

## What to expect

A maintainer reads each report and replies in the same private thread. This policy doesn't promise a response or fix time. Please give the maintainers time to ship a fix before you publish details.
