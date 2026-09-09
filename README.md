# Companion Hub

Local app runtime for the Companion Intelligence appliance. Installs and supervises marketplace apps as Docker Compose deployments, with a NestJS backend, React frontend, and Tauri desktop shell.

You can put almost anything in a container and run it here. A whole guest OS. A wealth dashboard you wrote in two prompts. A git repo you just cloned. Hub installs it, watches it, and puts it next to everything else you already run. That is the multi-app world, in one interface, on hardware you can see.

A few marketplace listings loop back on themselves. Ignore those. The point is your own infra: take a repo, even a messy first cut, and host it yourself.

## The nexus

Hub is not a single app. It is the layer that holds the rest together.

- **Containers.** Marketplace apps, custom Compose, and git repos you bring. Apps on apps is allowed. A server in a server is allowed.
- **Inference.** Voice, text, and image share a queue so they do not stampede the box. Speculative runners and hardware-specific paths on Mac and Linux make local models faster than a naive install. Pair more than one Hub and they pool work by queue depth.
- **Memory.** Companion Memory is the shared record. Harnesses and agents read the same graph instead of each keeping a private scrapbook.
- **MCP.** Hub is a nexus for MCP containers. Agents drive the stack through one tool surface.

Onboarding scans this machine and suggests models that fit. That scan is real. The suggestion still needs to be better. Local AI at small, capable sizes is still getting there; we are tightening the queue and the hardware pick so the box stays usable.

Hub is the data cube. Your data nugget server. The core is free to inspect and run for personal and nonprofit use. Portal is the optional door for sign-in, public web, and paid capacity. Add-ons are not a lock on this repo.

> You never change things by fighting the existing reality. To change something, build a new model that makes the existing model obsolete.
>
> R. Buckminster Fuller

## License

Companion Hub uses the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0). For common questions, see the [License FAQ](docs/License-FAQ.md) or email support@companionintelligence.com.

- License text: [`LICENSE.md`](LICENSE.md)
- License FAQ: [`docs/License-FAQ.md`](docs/License-FAQ.md)

Required Notice: Copyright LifeScope INC, DBA Companion Intelligence (https://ci.computer)

## Security (Hub and Portal)

Open-source Hub is an untrusted client of Companion Portal. See [`docs/security/hub-portal-trust.md`](docs/security/hub-portal-trust.md).

Marketplace installs and registry tag lists need a **Portal-issued device key**. Hub tries to send that key (`x-device-key`) after you pair this appliance ([CI-Portal#634](https://github.com/companionintelligence/CI-Portal/pull/634)). Paid marketplace apps also need an org entitlement on Portal; Hub's local cache is UX only and is not the till. If pairing never finishes, or this machine cannot store the key, those calls fail with `401`. Installs do not complete, and the catalog can look slow or empty instead of obviously unauthorized. Pair first (`cihub register` or the onboarding UI).

## Documentation

Start with [`docs/README.md`](docs/README.md) for the doc map, product glossary, tip scrub policy, and writing style.

## Quick start

```bash
pnpm install
pnpm run local
```

`pnpm install` needs a `NODE_AUTH_TOKEN` for the private `@companionintelligence` scope, and the
desktop app needs GTK/WebKit headers. Both failures and their fixes are in
[`docs/DEVELOPMENT_SETUP.md`](docs/DEVELOPMENT_SETUP.md).

See [`CLAUDE.md`](CLAUDE.md) for day-to-day development commands.
