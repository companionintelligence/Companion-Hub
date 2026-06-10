#!/usr/bin/env tsx
/**
 * Print shell exports for docker compose (source with eval).
 * Does not override CI_HUB_CONTAINER_UID/GID — those come from the env file (init:host).
 */
import { mergeComposeProfilesFromEnvFile } from './cihub-cli';
import { healHubPortsBeforeStartup } from './heal-hub-ports';

const envFile = process.argv[2] || process.env.ENV_FILE || '.env.dev';
const composeProfiles = mergeComposeProfilesFromEnvFile(envFile);
const portHeal = healHubPortsBeforeStartup(envFile);

process.stdout.write(`export ENV_FILE=${shellQuote(envFile)}\n`);
if (composeProfiles) {
  process.stdout.write(`export COMPOSE_PROFILES=${shellQuote(composeProfiles)}\n`);
}
for (const message of portHeal.info) {
  process.stderr.write(`${message}\n`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
