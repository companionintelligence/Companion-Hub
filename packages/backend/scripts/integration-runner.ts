/**
 * The backend integration test run: Postgres and RabbitMQ in a throwaway Compose project, vitest
 * against them, then the project removed. `run-integration.ts` is the command; this is the run, with
 * Docker and vitest behind {@link IntegrationRunnerIo} so a test can stand in for them.
 */
import { spawn } from 'node:child_process';

/** What the run does outside this process. */
export interface IntegrationRunnerIo {
  /** Runs a command with this process's terminal; rejects when it exits non-zero or is killed. */
  run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void>;
  /** Runs a command and resolves its trimmed stdout; rejects when it exits non-zero. */
  output(command: string, args: string[]): Promise<string>;
  log(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface IntegrationRun {
  composeFile: string;
  projectName: string;
  /** Passed to vitest after the config: file filters, `-t`, `-u`. */
  vitestArgs: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Starts the containers, runs the suite, and removes the containers, and returns the exit code.
 *
 * ⚠ THE REMOVAL RUNS ON EVERY PATH. It used to sit in a `finally` behind a `catch` that called
 * `process.exit(1)`, which ends the process before any `finally` runs, so every failed run left its
 * Postgres and RabbitMQ running (Companion-Hub#1834). Never exit from in here: return the code.
 */
export async function runIntegrationTests(run: IntegrationRun, io: IntegrationRunnerIo): Promise<number> {
  const compose = ['compose', '-p', run.projectName, '-f', run.composeFile];
  let exitCode = 0;

  try {
    io.log('Starting test containers...');
    await io.run('docker', [...compose, 'up', '-d', '--wait']);

    const dbPort = await publishedPort(io, compose, 'db', 6543);
    const rabbitPort = await publishedPort(io, compose, 'rabbitmq', 5672);
    io.log(`DB Port: ${dbPort}, RabbitMQ Port: ${rabbitPort}`);

    const env = {
      ...run.env,
      POSTGRES_PORT: dbPort,
      RABBITMQ_PORT: rabbitPort,
      POSTGRES_HOST: 'localhost',
      RABBITMQ_HOST: 'localhost',
    };

    io.log('Running tests...');
    await io.run('npx', ['vitest', '--watch=false', '--config', './vitest.integration.config.mts', ...run.vitestArgs], env);
  } catch (error) {
    io.error('Test run failed:', error);
    exitCode = 1;
  }

  // Also after a failed `up`: Compose may have created the network and one container before the other failed.
  io.log('Cleaning up...');
  const down = [...compose, 'down', '-v'];
  try {
    await io.run('docker', down);
  } catch (error) {
    io.error(`Could not remove the test containers. Remove them with: docker ${down.join(' ')}`, error);
    exitCode = 1;
  }

  return exitCode;
}

/** The host port Compose published for `service`'s `port`. Compose prints `0.0.0.0:32768` or `[::]:32768`. */
async function publishedPort(io: IntegrationRunnerIo, compose: string[], service: string, port: number): Promise<string> {
  const output = await io.output('docker', [...compose, 'port', service, port.toString()]);
  return output.split(':').at(-1) ?? '';
}

export const LIVE_INTEGRATION_RUNNER_IO: IntegrationRunnerIo = {
  run: (command, args, env = process.env) =>
    new Promise<void>((resolve, reject) => {
      const proc = spawn(command, args, { env, stdio: 'inherit' });
      proc.on('error', reject);
      proc.on('close', (code, signal) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(signal ? `${command} was stopped by ${signal}` : `Command failed with code ${code}`));
        }
      });
    }),
  output: (command, args) =>
    new Promise<string>((resolve, reject) => {
      const proc = spawn(command, args, { shell: true });
      let stdout = '';
      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Command failed with code ${code}`));
        }
      });
    }),
  log: (message) => console.log(message),
  error: (message, error) => (error === undefined ? console.error(message) : console.error(message, error)),
};
