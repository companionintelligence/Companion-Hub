#!/usr/bin/env tsx
/**
 * Wait until the Hub API responds on localhost (prod stack default: 5002).
 */
const PORTS = (process.env.CI_HUB_HEALTH_PORTS || '5002,3000')
  .split(',')
  .map((p) => Number.parseInt(p.trim(), 10))
  .filter((p) => Number.isFinite(p) && p > 0);

const TIMEOUT_MS = Number.parseInt(process.env.CI_HUB_HEALTH_TIMEOUT_MS || '180000', 10);
const INTERVAL_MS = 2000;

async function probe(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const port of PORTS) {
      if (await probe(port)) {
        console.log(`wait-hub-health: Hub healthy on http://localhost:${port}`);
        return;
      }
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  console.error(`wait-hub-health: timed out after ${TIMEOUT_MS}ms (tried ports: ${PORTS.join(', ')})`);
  process.exit(1);
}

main();
