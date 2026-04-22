/**
 * Playwright globalSetup — runs before webServer health checks.
 * Kills stale processes from previous E2E runs so startup scripts
 * launch fresh servers instead of Playwright reusing zombies.
 */
import { execSync } from 'node:child_process';

/** Kill any process listening on the given port. Skips Docker-proxy processes. */
function killPort(port: number): void {
  try {
    const pids = execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
    if (!pids) return;
    for (const pid of pids.split('\n')) {
      if (!pid) continue;
      try {
        const cmdline = execSync(`cat /proc/${pid}/cmdline 2>/dev/null || true`, { encoding: 'utf8' });
        if (cmdline.includes('docker-proxy')) continue;
      } catch {
        // /proc may not exist (macOS) — fall through to kill
      }
      // biome-ignore lint/suspicious/noConsole: globalSetup needs stdout logging for CI visibility
      console.log(`[global-setup] Killing stale process on port ${port} (pid ${pid})`);
      try {
        execSync(`kill ${pid} 2>/dev/null`);
      } catch {
        /* already dead */
      }
    }
  } catch {
    // lsof not available — skip
  }
}

/** Tear down the cross-domain Docker stack if any containers are running. */
function teardownDockerStack(): void {
  const PROJECT = 'ci-hub-e2e';
  try {
    const ps = execSync(
      `docker compose -p ${PROJECT} -f docker-compose.local.yml -f e2e/cross-domain/docker-compose.cross-domain.yml ps -q 2>/dev/null || true`,
      { encoding: 'utf8' },
    ).trim();
    if (ps) {
      // biome-ignore lint/suspicious/noConsole: globalSetup needs stdout logging for CI visibility
      console.log('[global-setup] Tearing down stale cross-domain Docker stack...');
      execSync(
        `docker compose -p ${PROJECT} -f docker-compose.local.yml -f e2e/cross-domain/docker-compose.cross-domain.yml down -v 2>/dev/null || true`,
        { stdio: 'inherit' },
      );
    }
  } catch {
    // Docker not available or compose failed — not fatal
  }
}

/** Tear down the standard E2E infra containers. */
function teardownStandardInfra(): void {
  try {
    const ps = execSync('docker compose -f e2e/docker-compose.e2e.yml ps -q 2>/dev/null || true', { encoding: 'utf8' }).trim();
    if (ps) {
      // biome-ignore lint/suspicious/noConsole: globalSetup needs stdout logging for CI visibility
      console.log('[global-setup] Tearing down stale standard E2E infra...');
      execSync('docker compose -f e2e/docker-compose.e2e.yml down -v 2>/dev/null || true', { stdio: 'inherit' });
    }
  } catch {
    // not fatal
  }
}

/** Remove stale data directories. */
function cleanDataDirs(): void {
  try {
    execSync('rm -rf /tmp/ci-hub-e2e 2>/dev/null || true');
  } catch {
    /* ignore */
  }
  try {
    execSync('rm -rf test-results 2>/dev/null || true');
  } catch {
    /* ignore */
  }
}

export default function globalSetup(): void {
  const mode = process.env.E2E_SUITE || 'standard';
  // biome-ignore lint/suspicious/noConsole: globalSetup needs stdout logging for CI visibility
  console.log(`[global-setup] Cleaning up before ${mode} E2E suite...`);

  // Kill ALL known E2E ports — regardless of which suite we are running,
  // the other suite leftovers can block us
  const ALL_PORTS = [3000, 5173, 8012, 9091, 6543, 5672, 8880, 8881, 8843];
  for (const port of ALL_PORTS) {
    killPort(port);
  }

  // Small grace period for processes to release ports
  execSync('sleep 1');

  // Tear down Docker stacks from either suite
  teardownDockerStack();
  teardownStandardInfra();

  // Clean data dirs
  cleanDataDirs();

  // For the standard suite, bring up infra (db + queue) that start-backend.sh expects
  if (mode === 'standard') {
    // biome-ignore lint/suspicious/noConsole: globalSetup needs stdout logging for CI visibility
    console.log('[global-setup] Starting standard E2E infra (db + queue)...');
    execSync('docker compose -f e2e/docker-compose.e2e.yml up -d db queue', { stdio: 'inherit' });
    // Wait for Postgres to be ready
    for (let i = 0; i < 30; i++) {
      try {
        execSync('docker compose -f e2e/docker-compose.e2e.yml exec -T db pg_isready -U companion -d companiondb 2>/dev/null', { encoding: 'utf8' });
        // biome-ignore lint/suspicious/noConsole: globalSetup needs stdout logging for CI visibility
        console.log('[global-setup] Postgres ready.');
        break;
      } catch {
        if (i === 29) console.warn('[global-setup] Postgres not ready after 30s — tests may fail');
        execSync('sleep 1');
      }
    }
  }

  // biome-ignore lint/suspicious/noConsole: globalSetup needs stdout logging for CI visibility
  console.log('[global-setup] Cleanup complete.');
}
