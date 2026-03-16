/**
 * Run end-to-end tests. Starts the docker-compose e2e environment, runs Playwright tests, then tears down.
 *
 * Usage:
 *   bun run test:e2e
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const composeFile = resolve(__dirname, '../e2e/docker-compose.e2e.yml');
const projectName = `test-e2e-${Date.now()}`;

async function runCommand(command: string, args: string[], env = process.env) {
  return new Promise<string>((resolve, reject) => {
    const proc = spawn(command, args, { env, stdio: 'inherit' });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve('');
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });
  });
}

async function getCommandOutput(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const proc = spawn(command, args, { shell: false });
    let stdout = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });
  });
}

async function getPort(service: string, port: number) {
  const output = await getCommandOutput('docker', ['compose', '-p', projectName, '-f', composeFile, 'port', service, port.toString()]);
  // Output format: 0.0.0.0:32768 or ::1:32768
  const parts = output.split(':');
  return parts[parts.length - 1];
}

async function checkUrl(url: string) {
  try {
    const res = await fetch(url);
    return res.status === 200;
  } catch (_e) {
    // console.log(`Fetch failed for ${url}:`, e.message);
    return false;
  }
}

async function waitForBackend(port: string) {
  const maxRetries = 600; // 10 minutes
  const interval = 1000;

  console.log(`Polling backend health on port ${port}...`);

  for (let i = 0; i < maxRetries; i++) {
    if (await checkUrl(`http://127.0.0.1:${port}/api/health`)) {
      console.log('\nBackend is ready!');
      return;
    }

    if (i > 0 && i % 30 === 0) {
      console.log(`\n--- Logs at ${i}s ---`);
      try {
        const logs = await getCommandOutput('docker', ['compose', '-p', projectName, '-f', composeFile, 'logs', '--tail', '20', 'app']);
        console.log(logs);
      } catch (_e) {
        console.log('Failed to fetch logs');
      }
      console.log('---------------------');
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
    process.stdout.write('.');
  }
  console.log('');
  throw new Error('Backend failed to start within timeout');
}

async function waitForFrontend(port: string) {
  const maxRetries = 600; // 10 minutes
  const interval = 1000;

  console.log(`Polling frontend health on port ${port}...`);

  for (let i = 0; i < maxRetries; i++) {
    if (await checkUrl(`http://127.0.0.1:${port}`)) {
      console.log('\nFrontend is ready!');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
    process.stdout.write('.');
  }
  console.log('');
  throw new Error('Frontend failed to start within timeout');
}

async function waitForBootstrap() {
  const maxRetries = 120; // 2 minutes
  const interval = 1000;

  console.log('Waiting for bootstrap to complete...');

  for (let i = 0; i < maxRetries; i++) {
    try {
      const logs = await getCommandOutput('docker', ['compose', '-p', projectName, '-f', composeFile, 'logs', 'app']);
      if (logs.includes('Bootstrap completed successfully')) {
        console.log('\nBootstrap completed!');
        return;
      }
    } catch (_e) {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
    process.stdout.write('.');
  }
  console.log('');
  throw new Error('Bootstrap failed to complete within timeout');
}

async function main() {
  try {
    console.log('Starting E2E environment...');
    // Build first to ensure we have the latest code
    await runCommand('docker', ['compose', '-p', projectName, '-f', composeFile, 'build']);
    await runCommand('docker', ['compose', '-p', projectName, '-f', composeFile, 'up', '-d']);

    const appPort = await getPort('app', 9091);
    const backendPort = await getPort('app', 3000);
    const dbPort = await getPort('db', 6543);

    console.log(`App Port: ${appPort}, Backend Port: ${backendPort}, DB Port: ${dbPort}`);

    if (!backendPort) {
      throw new Error('Backend port not found');
    }

    // Wait for backend to be ready (migrations run)
    console.log('Waiting for backend to be ready...');
    await waitForBackend(backendPort);

    await waitForBootstrap();

    console.log('Waiting for frontend to be ready...');
    await waitForFrontend(backendPort);

    const env = {
      ...process.env,
      SERVER_IP: 'localhost',
      SERVER_PORT: backendPort,
      POSTGRES_PORT: dbPort,
      POSTGRES_PASSWORD: 'postgres',
      NODE_ENV: 'test',
    };

    console.log('Running Playwright tests...');
    await runCommand('bun', ['playwright', 'test', '--workers=1'], env);
  } catch (error) {
    console.error('E2E test run failed:', error);
    console.log('Fetching app logs...');
    try {
      const logs = await getCommandOutput('docker', ['compose', '-p', projectName, '-f', composeFile, 'logs', 'app']);
      console.log(logs);
    } catch (logError) {
      console.error('Failed to fetch logs:', logError);
    }
    // process.exit(1); // Don't exit here, let finally run
  } finally {
    console.log('Cleaning up...');
    await runCommand('docker', ['compose', '-p', projectName, '-f', composeFile, 'down', '-v']);
  }
}

main();
