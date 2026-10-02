/**
 * Run backend integration tests. Starts postgres + rabbitmq via docker-compose, runs vitest, then tears down.
 *
 * Usage:
 *   pnpm run test:integration [-- <vitest-args>]
 *
 * Examples:
 *   pnpm run test:integration
 *   pnpm run test:integration -- --grep "registration"
 */
import { resolve } from 'node:path';
import { LIVE_INTEGRATION_RUNNER_IO, runIntegrationTests } from './integration-runner';

const composeFile = resolve(__dirname, '../src/tests/db.compose.yml');
const projectName = `test-backend-${Date.now()}`;

// Ctrl+C reaches Docker and vitest too, since they share this terminal. Left to its default it also
// ended this process on the spot, before the containers were removed. Caught, the children stop, the
// run fails, and the removal runs. A second Ctrl+C gives up on the removal.
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (interrupted) {
      process.exit(130);
    }
    interrupted = true;
    console.error(`\nStopping. Removing the test containers (${projectName}); press Ctrl+C again to leave them.`);
  });
}

// `pnpm run test:integration -- -u` forwards the `--` itself, and vitest then reads
// everything after it as file filters — so `-u`/`--grep` were silently ignored.
const vitestArgs = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === '--'));

runIntegrationTests({ composeFile, projectName, vitestArgs, env: process.env }, LIVE_INTEGRATION_RUNNER_IO).then((exitCode) => {
  process.exitCode = interrupted ? 130 : exitCode;
});
