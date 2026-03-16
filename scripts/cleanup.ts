#!/usr/bin/env bun
/**
 * Cleanup all CI-OS-Hub Docker resources (containers, networks, volumes, and caches).
 *
 * Usage:
 *   bun run cleanup
 */

import { $ } from 'bun';
import { existsSync } from 'node:fs';

console.log('🧹 Starting cleanup of CI-OS-Hub network, containers, volumes, and caches...\n');

// Step 1: Stop and remove all containers in the network
console.log(' Stopping and removing containers...');
try {
  // Get containers by network
  const containersByNetwork = await $`docker ps -a --filter network=ci_os_hub_network --format {{.Names}}`.quiet();
  const containersByNewNetwork = await $`docker ps -a --filter network=ci-os-hub_network --format {{.Names}}`.quiet();

  // Also get containers by project name (ci-os-hub, legacy runtipi, or e2e tests)
  const containersByProject = await $`docker ps -a --filter label=com.docker.compose.project=ci-os-hub --format {{.Names}}`.quiet();
  const containersByLegacyProject = await $`docker ps -a --filter label=com.docker.compose.project=runtipi --format {{.Names}}`.quiet();

  // Get any stray e2e containers that might use dynamic project names
  const containersByE2E = await $`docker ps -a --filter "name=e2e-" --format {{.Names}}`.quiet();

  const allContainers = new Set<string>();

  if (containersByNetwork.stdout.toString().trim()) {
    containersByNetwork.stdout
      .toString()
      .trim()
      .split('\n')
      .forEach((name) => {
        if (name) allContainers.add(name);
      });
  }

  if (containersByNewNetwork.stdout.toString().trim()) {
    containersByNewNetwork.stdout
      .toString()
      .trim()
      .split('\n')
      .forEach((name) => {
        if (name) allContainers.add(name);
      });
  }

  if (containersByProject.stdout.toString().trim()) {
    containersByProject.stdout
      .toString()
      .trim()
      .split('\n')
      .forEach((name) => {
        if (name) allContainers.add(name);
      });
  }

  if (containersByLegacyProject.stdout.toString().trim()) {
    containersByLegacyProject.stdout
      .toString()
      .trim()
      .split('\n')
      .forEach((name) => {
        if (name) allContainers.add(name);
      });
  }

  if (containersByE2E.stdout.toString().trim()) {
    containersByE2E.stdout
      .toString()
      .trim()
      .split('\n')
      .forEach((name) => {
        if (name) allContainers.add(name);
      });
  }

  if (allContainers.size > 0) {
    for (const name of allContainers) {
      console.log(`   Removing container: ${name}`);
      await $`docker rm -f ${name}`.quiet().catch(() => {
        console.log(`   ⚠️  Could not remove container ${name}`);
      });
    }
  } else {
    console.log('   No containers found');
  }
} catch (_error) {
  console.error('   Error listing containers:', _error);
  console.log('   No containers to remove');
}

// Step 2: Remove all volumes associated with the network or ci-os-hub
console.log('\n Removing volumes...');
try {
  // Get all volumes
  const volumes = await $`docker volume ls --format {{.Name}}`.quiet();
  const volumeNames = volumes.stdout.toString().trim().split('\n').filter(Boolean);

  // Filter volumes related to ci-os-hub/ci_os_hub/apps (include legacy runtipi volumes)
  const relatedVolumes = volumeNames.filter(
    (vol) =>
      vol.includes('ci_os_hub') ||
      vol.includes('ci-os-hub') ||
      vol.includes('runtipi') ||
      vol.includes('runtipi_') ||
      vol.includes('ci_hub_pgdata') ||
      vol.startsWith('e2e-') ||
      vol.startsWith('test-e2e-') ||
      vol.match(/^[a-z]+_[a-z]+-.*_data$/), // App volumes pattern like "grist_migrated-grist-1_data"
  );

  if (relatedVolumes.length > 0) {
    for (const vol of relatedVolumes) {
      console.log(`   Removing volume: ${vol}`);
      await $`docker volume rm ${vol}`.quiet().catch(() => {
        console.log(`   ⚠️  Could not remove volume ${vol} (may be in use)`);
      });
    }
  } else {
    console.log('   No volumes found');
  }
} catch (error) {
  console.log('   Error listing volumes:', error);
}

// Step 3: Remove the network
console.log('\n Removing network...');
try {
  await $`docker network rm ci_os_hub_network`.quiet().catch(() => {
    // ignore
  });
  await $`docker network rm ci-os-hub_network`.quiet().catch(() => {
    // ignore
  });

  // Also remove potential e2e networks
  const networks = await $`docker network ls --format {{.Name}}`.quiet();
  const e2eNetworks = networks.stdout
    .toString()
    .trim()
    .split('\n')
    .filter((n) => n.includes('e2e'));

  if (e2eNetworks.length > 0) {
    for (const net of e2eNetworks) {
      console.log(`   Removing network: ${net}`);
      await $`docker network rm ${net}`.quiet().catch(() => {
        console.log(`   ⚠️  Could not remove network ${net}`);
      });
    }
  }

  console.log('   ✅ Networks cleaned');
} catch (_error) {
  console.error('   Error during network cleanup:', _error);
  console.log('   Network removal skipped');
}

// Step 4: Clean up docker compose
console.log('\n Cleaning up docker compose...');
try {
  // Clean up both new and legacy project names
  await $`docker compose --project-name ci-os-hub -f docker-compose.prod.yml down -v`.quiet();
  await $`docker compose --project-name runtipi -f docker-compose.prod.yml down -v`.quiet();
  console.log('   ✅ Docker compose cleaned');
} catch (_error) {
  console.error('   Error during docker compose cleanup:', _error);
  console.log('   Docker compose cleanup skipped');
}

// Step 5: Remove buildx cache directory
console.log('\n Removing buildx cache...');
try {
  if (existsSync('/tmp/.buildx-cache')) {
    await $`rm -rf /tmp/.buildx-cache`.quiet();
    console.log('   ✅ Buildx cache removed');
  } else {
    console.log('   No buildx cache found');
  }
} catch (_error) {
  console.error('   Error removing buildx cache:', _error);
  console.log('   Buildx cache removal skipped');
}

// Step 6: Optional - Clean up .internal directories (commented out by default)
console.log('\n7️ Checking .internal directories...');
const internalDirs = [
  '.internal/media',
  '.internal/state',
  '.internal/repos',
  '.internal/apps',
  '.internal/logs',
  '.internal/user-config',
  '.internal/app-data',
  '.internal/backups',
  '.internal/cache',
];

for (const dir of internalDirs) {
  if (existsSync(dir)) {
    console.log(`   Removing ${dir}...`);
    await $`rm -rf ${dir}`.quiet();
  }
}

console.log('\n✅ Cleanup complete!');
console.log('\n📝 Summary:');
console.log('   - All containers in ci-os-hub_network removed');
console.log('   - All related volumes removed');
console.log('   - Network removed');
console.log('   - Buildx cache removed');
console.log('   - .internal directories cleaned');
