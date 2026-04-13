#!/usr/bin/env tsx
/**
 * Cleanup all CI-OS-Hub Docker resources (containers, networks, volumes, and caches).
 *
 * Usage:
 *   pnpm run cleanup
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function addNames(output: string, set: Set<string>) {
  if (output) {
    for (const name of output.split('\n')) {
      if (name.trim()) set.add(name.trim());
    }
  }
}

console.log('🧹 Starting cleanup of CI-OS-Hub network, containers, volumes, and caches...\n');

// Step 1: Stop and remove all containers in the network
console.log(' Stopping and removing containers...');
try {
  const allContainers = new Set<string>();
  addNames(exec('docker ps -a --filter network=ci_os_hub_network --format {{.Names}}'), allContainers);
  addNames(exec('docker ps -a --filter network=ci-os-hub_network --format {{.Names}}'), allContainers);
  addNames(exec('docker ps -a --filter label=com.docker.compose.project=ci-os-hub --format {{.Names}}'), allContainers);
  addNames(exec('docker ps -a --filter label=com.docker.compose.project=ci-hub --format {{.Names}}'), allContainers);
  addNames(exec('docker ps -a --filter "name=e2e-" --format {{.Names}}'), allContainers);

  if (allContainers.size > 0) {
    for (const name of allContainers) {
      console.log(`   Removing container: ${name}`);
      exec(`docker rm -f ${name}`);
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
  const volumeOutput = exec('docker volume ls --format {{.Name}}');
  const volumeNames = volumeOutput.split('\n').filter(Boolean);

  const relatedVolumes = volumeNames.filter(
    (vol) =>
      vol.includes('ci_os_hub') ||
      vol.includes('ci-os-hub') ||
      vol.includes('runtipi') ||
      vol.includes('runtipi_') ||
      vol.includes('ci_hub_pgdata') ||
      vol.startsWith('e2e-') ||
      vol.startsWith('test-e2e-') ||
      vol.match(/^[a-z]+_[a-z]+-.*_data$/),
  );

  if (relatedVolumes.length > 0) {
    for (const vol of relatedVolumes) {
      console.log(`   Removing volume: ${vol}`);
      exec(`docker volume rm ${vol}`);
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
  exec('docker network rm ci_os_hub_network');
  exec('docker network rm ci-os-hub_network');

  const networks = exec('docker network ls --format {{.Name}}');
  const e2eNetworks = networks.split('\n').filter((n) => n.includes('e2e'));

  if (e2eNetworks.length > 0) {
    for (const net of e2eNetworks) {
      console.log(`   Removing network: ${net}`);
      exec(`docker network rm ${net}`);
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
  exec('docker compose --project-name ci-os-hub -f docker-compose.prod.yml down -v');
  exec('docker compose --project-name ci-hub -f docker-compose.prod.yml down -v');
  exec('docker compose --project-name runtipi -f docker-compose.prod.yml down -v');
  exec('docker compose --project-name ci-hub -f docker-compose.local.yml down -v');
  console.log('   ✅ Docker compose cleaned');
} catch (_error) {
  console.error('   Error during docker compose cleanup:', _error);
  console.log('   Docker compose cleanup skipped');
}

// Step 5: Remove buildx cache directory
console.log('\n Removing buildx cache...');
try {
  if (existsSync('/tmp/.buildx-cache')) {
    exec('rm -rf /tmp/.buildx-cache');
    console.log('   ✅ Buildx cache removed');
  } else {
    console.log('   No buildx cache found');
  }
} catch (_error) {
  console.error('   Error removing buildx cache:', _error);
  console.log('   Buildx cache removal skipped');
}

// Step 6: Clean up .internal directories and tunnel state
console.log('\n Cleaning .internal and tunnel state...');

if (existsSync('.internal')) {
  console.log('   Removing .internal/ (sudo)...');
  exec('sudo rm -rf .internal');
}

const tunnelDirs = ['tunnel/token', 'tunnel/certs'];
for (const td of tunnelDirs) {
  if (existsSync(td)) {
    console.log(`   Removing ${td}...`);
    exec(`sudo rm -rf ${td}`);
  }
}

console.log('\n✅ Cleanup complete!');
console.log('\n📝 Summary:');
console.log('   - All containers in ci-os-hub_network removed');
console.log('   - All related volumes removed');
console.log('   - Network removed');
console.log('   - Buildx cache removed');
console.log('   - .internal directories cleaned');
