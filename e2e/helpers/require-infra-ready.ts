import { requireInfraReady } from './infra.js';

async function main() {
  const retries = Number(process.env.E2E_INFRA_RETRIES || '15');
  const intervalMs = Number(process.env.E2E_INFRA_INTERVAL_MS || '1000');

  await requireInfraReady(retries, intervalMs);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
