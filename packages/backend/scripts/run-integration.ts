import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const composeFile = resolve(__dirname, '../src/tests/db.compose.yml');
const projectName = `test-backend-${Date.now()}`;

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
    const proc = spawn(command, args, { shell: true });
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

async function main() {
  try {
    console.log('Starting test containers...');
    await runCommand('docker', ['compose', '-p', projectName, '-f', composeFile, 'up', '-d', '--wait']);

    const dbPort = await getPort('db', 6543);
    const rabbitPort = await getPort('rabbitmq', 5672);

    console.log(`DB Port: ${dbPort}, RabbitMQ Port: ${rabbitPort}`);

    const env = {
      ...process.env,
      POSTGRES_PORT: dbPort,
      RABBITMQ_PORT: rabbitPort,
      POSTGRES_HOST: 'localhost',
      RABBITMQ_HOST: 'localhost',
    };

    console.log('Running tests...');
    const args = ['vitest', '--watch=false', '--config', './vitest.integration.config.mts', ...process.argv.slice(2)];
    await runCommand('bun', args, env);
  } catch (error) {
    console.error('Test run failed:', error);
    process.exit(1);
  } finally {
    console.log('Cleaning up...');
    await runCommand('docker', ['compose', '-p', projectName, '-f', composeFile, 'down', '-v']);
  }
}

main();
