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

runtipi uses [`pnpm`](https://pnpm.io/) as its package manager, and `turbo.js` as its monorepo orchestrator. Install pnpm using the instructions from the [official pnpm website](https://pnpm.io/installation).

Install the project dependencies
`pnpm install`

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

## Run runtipi

1. Start the app with `pnpm run start:dev` from the root folder
2. Visit `localhost:3000` in your browser