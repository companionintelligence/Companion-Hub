#!/usr/bin/env tsx
/**
 * Print COMPOSE_PROFILES for a hub env file (private-vpn + cloudflare when tunnel token exists).
 * Used by package.json start:* scripts so CLI matches desktop/cihub profile merging.
 */
import { mergeComposeProfilesFromEnvFile } from './cihub-cli';

const envFile = process.argv[2] || '.env.dev';
process.stdout.write(mergeComposeProfilesFromEnvFile(envFile));
