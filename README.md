# Companion Hub

Local app runtime for the Companion Intelligence appliance. Installs and supervises marketplace apps as Docker Compose deployments, with a NestJS backend, React frontend, and Tauri desktop shell.

## License

Companion Hub uses the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0). For common questions, see the [License FAQ](docs/License-FAQ.md) or email support@companionintelligence.com.

- License text: [`LICENSE.md`](LICENSE.md)
- License FAQ: [`docs/License-FAQ.md`](docs/License-FAQ.md)

Required Notice: Copyright LifeScope INC, DBA Companion Intelligence (https://ci.computer)

## Security (Hub and Portal)

Open-source Hub is an untrusted client of Companion Portal. See [`docs/security/hub-portal-trust.md`](docs/security/hub-portal-trust.md).

## Documentation

Start with [`docs/README.md`](docs/README.md) for the doc map, product glossary, tip scrub policy, and writing style.

## Quick start

```bash
pnpm install
pnpm run local
```

See [`CLAUDE.md`](CLAUDE.md) for day-to-day development commands.
