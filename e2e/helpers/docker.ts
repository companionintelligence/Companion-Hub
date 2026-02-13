/**
 * Docker Helper for E2E Tests
 *
 * Utilities to verify container state during tests
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface ContainerInfo {
  id: string;
  name: string;
  status: string;
  image: string;
  ports: string;
}

export class DockerHelper {
  private serverHost: string;
  private sshUser: string;

  constructor(serverHost?: string, sshUser = 'ci') {
    this.serverHost = serverHost || process.env.TEST_SERVER_HOST || 'localhost';
    this.sshUser = sshUser;
  }

  private async runCommand(cmd: string): Promise<string> {
    if (this.serverHost === 'localhost' || this.serverHost === '127.0.0.1') {
      const { stdout } = await execAsync(cmd);
      return stdout.trim();
    }
    // Run via SSH
    const { stdout } = await execAsync(`ssh -o StrictHostKeyChecking=no ${this.sshUser}@${this.serverHost} "${cmd}"`);
    return stdout.trim();
  }

  /**
   * Get container by name
   */
  async getContainer(name: string): Promise<ContainerInfo | null> {
    try {
      const output = await this.runCommand(`docker ps -a --filter "name=${name}" --format "{{.ID}}|{{.Names}}|{{.Status}}|{{.Image}}|{{.Ports}}"`);

      if (!output) return null;

      const [id, containerName, status, image, ports] = output.split('|');
      return { id, name: containerName, status, image, ports };
    } catch {
      return null;
    }
  }

  /**
   * Check if container is running
   */
  async isContainerRunning(name: string): Promise<boolean> {
    try {
      const output = await this.runCommand(`docker ps --filter "name=${name}" --filter "status=running" --format "{{.Names}}"`);
      return output.includes(name);
    } catch {
      return false;
    }
  }

  /**
   * List all containers with a prefix
   */
  async listContainers(prefix: string): Promise<ContainerInfo[]> {
    try {
      const output = await this.runCommand(`docker ps -a --filter "name=${prefix}" --format "{{.ID}}|{{.Names}}|{{.Status}}|{{.Image}}|{{.Ports}}"`);

      if (!output) return [];

      return output.split('\n').map((line) => {
        const [id, name, status, image, ports] = line.split('|');
        return { id, name, status, image, ports };
      });
    } catch {
      return [];
    }
  }

  /**
   * Find orphan resources (containers, volumes, networks) for an app
   */
  async findOrphanResources(appId: string): Promise<string[]> {
    const orphans: string[] = [];

    try {
      // Check for orphan containers
      const containers = await this.runCommand(`docker ps -a --filter "label=ci.app.id=${appId}" --format "{{.Names}}"`);
      if (containers) {
        orphans.push(...containers.split('\n').map((c) => `container:${c}`));
      }

      // Check for orphan volumes
      const volumes = await this.runCommand(`docker volume ls --filter "label=ci.app.id=${appId}" --format "{{.Name}}"`);
      if (volumes) {
        orphans.push(...volumes.split('\n').map((v) => `volume:${v}`));
      }

      // Check for orphan networks
      const networks = await this.runCommand(`docker network ls --filter "label=ci.app.id=${appId}" --format "{{.Name}}"`);
      if (networks) {
        orphans.push(...networks.split('\n').map((n) => `network:${n}`));
      }
    } catch (e) {
      console.error('Error checking orphan resources:', e);
    }

    return orphans;
  }

  /**
   * Get container logs
   */
  async getContainerLogs(name: string, lines = 100): Promise<string> {
    try {
      return await this.runCommand(`docker logs --tail ${lines} ${name} 2>&1`);
    } catch {
      return '';
    }
  }

  /**
   * Check container health
   */
  async getContainerHealth(name: string): Promise<'healthy' | 'unhealthy' | 'starting' | 'none' | 'unknown'> {
    try {
      const output = await this.runCommand(`docker inspect --format='{{.State.Health.Status}}' ${name} 2>/dev/null || echo "none"`);

      if (output.includes('healthy')) return 'healthy';
      if (output.includes('unhealthy')) return 'unhealthy';
      if (output.includes('starting')) return 'starting';
      if (output.includes('none')) return 'none';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Force remove container (for cleanup)
   */
  async removeContainer(name: string, force = true): Promise<boolean> {
    try {
      await this.runCommand(`docker rm ${force ? '-f' : ''} ${name}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get container resource usage
   */
  async getContainerStats(name: string): Promise<{ cpu: string; memory: string } | null> {
    try {
      const output = await this.runCommand(`docker stats ${name} --no-stream --format "{{.CPUPerc}}|{{.MemUsage}}"`);

      const [cpu, memory] = output.split('|');
      return { cpu, memory };
    } catch {
      return null;
    }
  }
}

// Export singleton for convenience
export const docker = new DockerHelper();
