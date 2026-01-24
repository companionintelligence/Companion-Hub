import { spawn } from 'node:child_process';
import path from 'node:path';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable, InternalServerErrorException, Inject, forwardRef } from '@nestjs/common';
import type { AppUrn } from '@runtipi/common/types';
import * as Sentry from '@sentry/nestjs';
import { AppFilesManager } from '../apps/app-files-manager';
import { AppsService } from '../apps/apps.service';

@Injectable()
export class DockerService {
  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    @Inject(forwardRef(() => AppFilesManager)) private readonly appFilesManager: AppFilesManager,
    private readonly filesystem: FilesystemService,
    @Inject(forwardRef(() => AppsService)) private readonly appsService: AppsService,
  ) {}

  /**
   * Get the base compose args for an app

   * @param {string} appUrn - App name
   */
  public getBaseComposeArgsApp = async (appUrn: AppUrn) => {
    let isCustomConfig = false;

    const appEnv = await this.appFilesManager.getAppEnv(appUrn);
    const args: string[] = ['--env-file', appEnv.path];

    const { app } = await this.appsService.getApp(appUrn);
    const userConfigEnabled = app?.userConfigEnabled ?? true;

    // User custom env file
    const userEnvFile = await this.appFilesManager.getUserEnv(appUrn);
    if (userEnvFile.content && userConfigEnabled) {
      isCustomConfig = true;
      args.push('--env-file', userEnvFile.path);
    }

    args.push('--project-name', appUrn.replace(':', '_'));

    const composeFile = await this.appFilesManager.getDockerComposeYaml(appUrn);
    args.push('-f', composeFile.path);

    // User defined overrides
    const userComposeFile = await this.appFilesManager.getUserComposeFile(appUrn);
    if (userComposeFile.content && userConfigEnabled) {
      isCustomConfig = true;
      args.push('--file', userComposeFile.path);
    }

    return { args, isCustomConfig };
  };

  public getBaseComposeArgsRuntipi = async () => {
    const { dataDir } = this.config.get('directories');
    const args: string[] = ['--env-file', path.join(dataDir, '.env')];

    args.push('--project-name', 'runtipi');

    const composeFile = path.join(dataDir, 'docker-compose.yml');
    args.push('-f', composeFile);

    // User defined overrides
    const userComposeFile = path.join(dataDir, 'user-config', 'tipi-compose.yml');
    if (await this.filesystem.pathExists(userComposeFile)) {
      args.push('--file', userComposeFile);
    }

    return { args };
  };

  /**
   * Helpers to execute docker compose commands
   * @param {string} appUrn - App name
   * @param {string} command - Command to execute
   */
  public async composeApp(appUrn: AppUrn, command: string) {
    let { args, isCustomConfig } = await this.getBaseComposeArgsApp(appUrn);
    args.push(...command.split(' '));
    args = args.filter(Boolean);

    // Get the compose file path to set as working directory
    // This ensures docker-compose resolves relative paths correctly
    const composeFile = await this.appFilesManager.getDockerComposeYaml(appUrn);
    const composeDir = path.dirname(composeFile.path);

    this.logger.info(`Running docker compose with args ${args.join(' ')} from directory ${composeDir}`);

    // Prefer docker compose (v2 plugin) over docker-compose (v1 binary) for better compatibility
    // Try docker compose first, fallback to docker-compose binary if needed
    try {
      // Verify docker compose is available before using it
      const testCmd = spawn('docker', ['compose', 'version'], { stdio: 'pipe' });
      await new Promise<void>((resolve, reject) => {
        testCmd.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`docker compose not available (exit code: ${code})`));
          }
        });
        testCmd.on('error', reject);
      });

      this.logger.debug('docker compose plugin is available, using it');
      // Use docker compose plugin (docker-cli is installed in the container)
      return this.runDockerCompose(['docker', 'compose', ...args], composeDir, isCustomConfig);
    } catch (_error) {
      // Fallback to docker-compose binary if docker compose plugin is not available
      this.logger.warn('docker compose plugin not available, falling back to docker-compose binary');
      return this.runDockerCompose(['docker-compose', ...args], composeDir, isCustomConfig).catch((fallbackError: unknown) => {
        const err = fallbackError as Error & { code?: string };
        throw new Error(`Both docker compose and docker-compose failed: ${err.message || String(fallbackError)}`);
      });
    }
  }

  private async runDockerCompose(command: string[], cwd: string, isCustomConfig: boolean) {
    // Log the full command for debugging
    this.logger.debug(`Executing: ${command[0]} ${command.slice(1).join(' ')}`);

    if (!command[0]) {
      throw new Error('Command is empty');
    }

    const cmd = spawn(command[0], command.slice(1), {
      cwd, // Set working directory to compose file's directory
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await new Promise<number>((resolve, reject) => {
      cmd.on('error', (error: NodeJS.ErrnoException) => {
        this.logger.error(`Failed to spawn ${command[0]}: ${error.message}`);
        if (error.code === 'ENOEXEC') {
          this.logger.error(`${command[0]} binary cannot be executed. This usually means the binary is corrupted or for the wrong architecture.`);
        }
        reject(error);
      });
      cmd.stdout.on('data', (data: Buffer | string) => {
        this.logger.debug(`${command[0]}: ${String(data).trim()}`);
        stdout.push(String(data).trim());
      });
      cmd.stderr.on('data', (data: Buffer | string) => {
        this.logger.debug(`${command[0]}: ${String(data).trim()}`);
        stderr.push(String(data).trim());
      });
      cmd.on('close', resolve);
    });

    if (exitCode !== 0) {
      this.logger.info(`${command[0]} exited with code ${exitCode}`);
      if (isCustomConfig) {
        this.logger.warn('User-config detected, please make sure your configuration is correct before opening an issue');
      }
      const error = stderr.pop();
      throw new Error(error);
    }

    return { success: true, stdout: stdout.join(''), stderr: stderr.join('') };
  }

  public getLogsStream = async (maxLines: number, appUrn?: AppUrn) => {
    try {
      const { args } = appUrn ? await this.getBaseComposeArgsApp(appUrn) : await this.getBaseComposeArgsRuntipi();

      args.push('logs', '--follow', '-n', maxLines.toString());

      // Prefer docker compose (v2 plugin) over docker-compose (v1 binary)
      let logs: ReturnType<typeof spawn>;
      try {
        // Try docker compose first
        logs = spawn('docker', ['compose', ...args], { stdio: 'pipe' });
      } catch (_error) {
        // Fallback to docker-compose binary
        this.logger.warn('docker compose plugin not available for logs, falling back to docker-compose binary');
        logs = spawn('docker-compose', args, { stdio: 'pipe' });
      }

      logs.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOEXEC') {
          this.logger.error('docker-compose binary cannot be executed. Please ensure docker compose plugin is available.');
        }
      });

      logs.on('error', () => {
        logs.kill('SIGINT');
      });

      if (!logs.stdout) {
        throw new InternalServerErrorException('Docker output stream not available');
      }

      return {
        on: logs.stdout.on.bind(logs.stdout),
        kill: () => logs.kill('SIGINT'),
      };
    } catch (error) {
      this.logger.error('Error getting log stream', error);
      Sentry.captureException(error, { tags: { source: 'docker log stream', appUrn } });
      throw new InternalServerErrorException('Error getting log stream');
    }
  };

  /**
   * Get all exposed host ports for an app's containers
   * Uses docker compose port command to get actual mapped host ports
   * @param appUrn - The app URN
   * @returns Array of host port numbers that are exposed
   */
  public async getExposedPorts(appUrn: AppUrn): Promise<number[]> {
    try {
      // args is not used here but required to destructure if getBaseComposeArgsApp returns it
      // However, check what getBaseComposeArgsApp does. If it's just getting args, maybe we don't need to call it if we don't use args.
      // But maybe it has side effects or validates something?
      // Assuming we can just ignore it for now.
      await this.getBaseComposeArgsApp(appUrn);
      const composeFile = await this.appFilesManager.getDockerComposeYaml(appUrn);
      const _composeDir = path.dirname(composeFile.path);

      // Get all services from compose file
      const composeJson = await this.appFilesManager.getDockerComposeJson(appUrn);
      if (!composeJson.content) {
        this.logger.warn(`No compose JSON found for ${appUrn}`);
        return [];
      }

      const composeContent = composeJson.content as { services?: Record<string, { ports?: string[] }> };
      const services = composeContent.services || {};

      const exposedPorts: number[] = [];

      // For each service, get its exposed ports
      for (const [serviceName, serviceConfig] of Object.entries(services)) {
        if (!serviceConfig.ports || serviceConfig.ports.length === 0) {
          continue;
        }

        // Parse port mappings (format: "hostPort:containerPort" or "${VAR}:containerPort")
        for (const portMapping of serviceConfig.ports) {
          const [hostPortStr, containerPort] = portMapping.split(':');

          // Skip if hostPortStr is undefined or empty
          if (!hostPortStr) {
            continue;
          }

          // Try to resolve host port (might be a variable like ${APP_PORT})
          let hostPort: number | null = null;

          // If it's a number, use it directly
          const parsedPort = Number.parseInt(hostPortStr, 10);
          if (!Number.isNaN(parsedPort)) {
            hostPort = parsedPort;
          } else if (hostPortStr.startsWith('${') && hostPortStr.endsWith('}')) {
            // It's a variable, try to resolve from env
            const varName = hostPortStr.slice(2, -1);
            const appEnv = await this.appFilesManager.getAppEnv(appUrn);
            const envLines = appEnv.content?.split('\n') || [];

            for (const line of envLines) {
              const match = line.match(new RegExp(`^${varName}=(.+)$`));
              if (match?.[1]) {
                const value = match[1].trim();
                const portValue = Number.parseInt(value, 10);
                if (!Number.isNaN(portValue)) {
                  hostPort = portValue;
                  break;
                }
              }
            }
          }

          // If we still don't have a port, try docker compose port command
          if (hostPort === null && containerPort) {
            try {
              // Use docker compose port command to get actual mapped port
              const portResult = await this.composeApp(appUrn, `port ${serviceName} ${containerPort}`);
              const portOutput = portResult.stdout.trim();

              // Parse output format: "0.0.0.0:32768" or "::1:32768"
              if (portOutput) {
                const parts = portOutput.split(':');
                if (parts.length > 0) {
                  const lastPart = parts[parts.length - 1];
                  if (lastPart) {
                    const resolvedPort = Number.parseInt(lastPart, 10);
                    if (!Number.isNaN(resolvedPort)) {
                      hostPort = resolvedPort;
                    }
                  }
                }
              }
            } catch (error) {
              // Port command might fail if container isn't running yet - that's okay
              this.logger.debug(`Could not get port for service ${serviceName} (container may not be running): ${error}`);
            }
          }

          if (hostPort !== null && !exposedPorts.includes(hostPort)) {
            exposedPorts.push(hostPort);
          }
        }
      }

      return exposedPorts.sort((a, b) => a - b);
    } catch (error) {
      this.logger.error(`Error getting exposed ports for ${appUrn}:`, error);
      return [];
    }
  }

  /**
   * Restart a specific container by name using system docker command
   */
  public async restartContainer(containerName: string): Promise<void> {
    this.logger.info(`Restarting container: ${containerName}`);

    return new Promise((resolve, reject) => {
      const cmd = spawn('docker', ['restart', containerName]);

      cmd.on('close', (code) => {
        if (code === 0) {
          this.logger.info(`Container ${containerName} restarted successfully`);
          resolve();
        } else {
          this.logger.error(`Failed to restart container ${containerName}, exit code: ${code}`);
          reject(new Error(`Failed to restart container ${containerName}`));
        }
      });

      cmd.on('error', (err) => {
        this.logger.error(`Error spawning docker restart command: ${err}`);
        reject(err);
      });
    });
  }
}
