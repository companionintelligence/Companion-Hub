# CI-OS-Hub

REQUIRED: APP STORE
https://github.com/companionintelligence/CI-App-Store

APP STORE LAUNCHER
https://github.com/companionintelligence/companionintelligence.github.io

Based on Runtipi — A personal homeserver for everyone

https://github.com/runtipi/runtipi-appstore

https://www.runtipi.io/docs/getting-started/installation?utm_source=github&utm_campaign=readme

https://forums.runtipi.io

# Running locally

In this guide we will show you how to run Runtipi locally on your machine. This is useful if you want to contribute to the project or if you want to test new apps you added to the appstore.

## Prerequisites

- Docker desktop version 28 or later. Instructions: [Install Docker Engine](https://docs.docker.com/engine/install/)
- Docker-compose
- Node version 22+

## Prepare

Once you have forked the repository and cloned it on your local machine you can start to prepare the environment.

## Install dependencies

runtipi uses [`bun`](https://bun.com/) as its JavaScript runtime and package manager, and `turbo.js` as its monorepo orchestrator. Install Bun using the instructions from the [official Bun website](https://bun.com/).

Install the project dependencies
`bun install`

## Edit the environment variables

You need to copy `.env.example` to `.env`

## Cloudflare Tunnel Token

To enable the Cloudflare Tunnel integration (exposed apps), you must have a valid tunnel token.
Place your token in the `tunnel/token` file:

`echo "YOUR_TUNNEL_TOKEN" > tunnel/token`

This token allows the `cloudflared` daemon to authenticate with Cloudflare.

## Generate Tunnel Certificates

If you are working with the Cloudflare Tunnel integration (exposed apps), you need to generate a local Certificate Authority. This allows the `cloudflared` daemon to trust your local HTTPS services.

Run the helper script:
`./scripts/generate-tunnel-certs.sh`

This will create `tunnel/certs/custom-ca.pem` and `custom-ca.key`.

## Run CI OS Hub locally

We have consolidated the local development workflow into a single command.

### `bun dev` (Recommended)

This is the main command for local development. It does the following:
1. Starts the required infrastructure (Postgres DB, RabbitMQ) in Docker containers in the background.
2. Starts the Backend (NestJS) in watch mode.
3. Starts the Frontend (React Router) in HMR mode.

Both the backend and frontend will hot-reload on file changes.

### Other Commands

- `bun run build`: Builds all packages.
- `bun run test`: Runs all tests.
- `bun run cleanup`: Stops infrastructure containers and removes temporary files/directories (`.internal`, certs).
- `bun run start:docker`: Runs the entire stack (including the Hub app itself) inside Docker containers. This is closer to how it runs in production but slower for development loop.
- `bun run start:prod`: Simulates a production environment (uses production env vars and connects to live cloud APIs).
- `bun run start:staging`: Simulates staging environment (connects to companionintel.com API).
- `bun run start:cloud-dev`: Simulates development environment (connects to setup.companionintelligence.com API).

### Accessing the App

Once `bun dev` is running:
- **Frontend** is available at `http://localhost:5173` (or the port shown in terminal).
- **Backend API** is available at `http://localhost:3000`.