import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable, Inject } from '@nestjs/common';
import Dockerode from 'dockerode';
import * as yaml from 'yaml';
import { DOCKERODE } from './constants';

interface TraefikRouter {
  rule: string;
  service: string;
  entryPoints: string[];
  middlewares?: string[];
  tls?: boolean;
}

interface TraefikService {
  loadBalancer: {
    servers: Array<{ url: string }>;
  };
}

interface TraefikConfig {
  http: {
    routers: Record<string, TraefikRouter>;
    services: Record<string, TraefikService>;
  };
}

@Injectable()
export class TraefikConfigService {
  private readonly mainNetworkName: string;

  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly filesystem: FilesystemService,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
  ) {
    this.mainNetworkName = `${process.env.HUB_CONTAINER_NAME || 'ci-os-hub'}_network`;
  }

  /**
   * Generate Traefik file-based configuration from running Docker containers
   * This is a workaround for Traefik Docker provider API version incompatibility
   */
  public async generateTraefikConfig(): Promise<void> {
    try {
      this.logger.debug('Generating Traefik file-based configuration from Docker containers...');

      const { directories } = this.config.getConfig();
      const configPath = `${directories.dataDir}/state/traefik/dynamic/apps.yml`;

      // Check if there's an existing invalid config file and remove it first
      // This prevents Traefik from trying to parse invalid YAML
      if (await this.filesystem.pathExists(configPath)) {
        try {
          const existingContent = await this.filesystem.readTextFile(configPath);
          if (existingContent) {
            // Try to parse it to see if it's valid
            try {
              yaml.parse(existingContent);
            } catch {
              // Invalid YAML - delete it
              this.logger.debug(`Removing invalid Traefik config file at ${configPath}`);
              await this.filesystem.removeFile(configPath);
            }
          }
        } catch {
          // If we can't read it, try to remove it anyway
          await this.filesystem.removeFile(configPath);
        }
      }

      const containers = await this.docker.listContainers({
        filters: {
          label: ['traefik.enable=true'],
        },
      });

      const config: TraefikConfig = {
        http: {
          routers: {},
          services: {},
        },
      };

      // Process each container
      for (const containerInfo of containers) {
        const container = this.docker.getContainer(containerInfo.Id);
        const inspect = await container.inspect();

        // Skip ci-os-hub and traefik containers (they're handled separately)
        if (inspect.Name.includes('ci-os-hub') || inspect.Name.includes('traefik')) {
          continue;
        }

        // Get container IP from the main network
        const networkSettings = inspect.NetworkSettings?.Networks?.[this.mainNetworkName];
        if (!networkSettings?.IPAddress) {
          this.logger.debug(`Skipping container ${inspect.Name}: not on ${this.mainNetworkName} network or IP not assigned yet`);
          continue;
        }

        const containerIP = networkSettings.IPAddress;
        const labels = inspect.Config?.Labels || {};

        // Extract Traefik routing information from labels
        const routers: Record<string, TraefikRouter> = {};
        const services: Record<string, TraefikService> = {};

        // Find all router labels
        for (const [key, value] of Object.entries(labels)) {
          if (key.startsWith('traefik.http.routers.')) {
            const routerName = key.replace('traefik.http.routers.', '').split('.')[0];
            const property = key.split('.').pop();

            if (!routerName) continue;

            if (!routers[routerName]) {
              routers[routerName] = {
                rule: '',
                service: '',
                entryPoints: [],
              };
            }

            // Ensure property exists
            if (!property) continue;

            switch (property) {
              case 'rule':
                routers[routerName].rule = String(value);
                break;
              case 'entrypoints':
                routers[routerName].entryPoints = String(value).split(',');
                break;
              case 'service':
                routers[routerName].service = String(value);
                break;
              case 'middlewares':
                routers[routerName].middlewares = String(value).split(',');
                break;
              case 'tls':
                routers[routerName].tls = String(value) === 'true';
                break;
            }
          }

          // Find service port from labels
          if (key.startsWith('traefik.http.services.') && key.endsWith('.loadbalancer.server.port')) {
            const serviceName = key.replace('traefik.http.services.', '').replace('.loadbalancer.server.port', '');
            const port = Number.parseInt(String(value), 10);

            if (!Number.isNaN(port)) {
              services[serviceName] = {
                loadBalancer: {
                  servers: [{ url: `http://${containerIP}:${port}` }],
                },
              };
            }
          }
        }

        // Only add routers that have valid rules and services
        for (const [routerName, router] of Object.entries(routers)) {
          if (router.rule && router.service && router.entryPoints.length > 0) {
            // Only add insecure routers (web entrypoint) for file provider
            // Secure routers (websecure) require TLS which file provider handles differently
            // Note: Traefik's file provider automatically adds @file suffix, so we don't add it here
            if (router.entryPoints.includes('web')) {
              config.http.routers[routerName] = router;
            }
          }
        }

        // Add services
        Object.assign(config.http.services, services);
      }

      // Write the configuration file
      // configPath already defined at the start of the function

      const routerCount = Object.keys(config.http.routers).length;
      const serviceCount = Object.keys(config.http.services).length;

      // Traefik doesn't accept empty routers/services objects - only write file if we have content
      if (routerCount === 0 && serviceCount === 0) {
        // Delete the file if it exists to avoid stale/invalid config
        if (await this.filesystem.pathExists(configPath)) {
          this.logger.debug(`No routers/services found, deleting stale Traefik config at ${configPath}`);
          await this.filesystem.removeFile(configPath);
        } else {
          this.logger.debug('No routers/services found, skipping Traefik config file write');
        }
        return;
      }

      // Only include non-empty sections in the config
      const validConfig: Partial<TraefikConfig> = {
        http: {},
      };

      if (routerCount > 0) {
        validConfig.http!.routers = config.http.routers;
      }
      if (serviceCount > 0) {
        validConfig.http!.services = config.http.services;
      }

      const yamlContent = yaml.stringify(validConfig, { indent: 2 });

      this.logger.debug(`Writing Traefik config to ${configPath}`);
      await this.filesystem.writeTextFile(configPath, yamlContent);

      // Verify the file was written correctly
      const writtenContent = await this.filesystem.readTextFile(configPath);
      if (!writtenContent || writtenContent.trim().length === 0) {
        throw new Error('Failed to write Traefik config: file is empty after write');
      }

      this.logger.info(`Generated Traefik config with ${routerCount} routers and ${serviceCount} services and wrote to ${configPath}`);

      // Log router names for debugging
      if (routerCount > 0) {
        this.logger.debug(`Routers: ${Object.keys(config.http.routers).join(', ')}`);
      }
    } catch (error) {
      this.logger.error('Error generating Traefik config:', error);
      throw error;
    }
  }

  /**
   * Regenerate Traefik config after a short delay to allow containers to start
   * Retries up to 3 times if containers aren't ready yet
   */
  public async regenerateTraefikConfig(delayMs = 2000, maxRetries = 3): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(async () => {
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            await this.generateTraefikConfig();
            resolve();
            return;
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (attempt < maxRetries) {
              this.logger.debug(`Traefik config generation attempt ${attempt} failed, retrying in 2s...`);
              await new Promise((r) => setTimeout(r, 2000));
            }
          }
        }
        this.logger.error(`Error regenerating Traefik config after ${maxRetries} attempts:`, lastError);
        resolve(); // Don't throw, just log - we don't want to fail app operations
      }, delayMs);
    });
  }
}
