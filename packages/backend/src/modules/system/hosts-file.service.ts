import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import fs from 'node:fs/promises';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { Inject } from '@nestjs/common';
import type { AsyncMutex } from '@/utils/mutex/async-mutex';

@Injectable()
export class HostsFileService {
  private readonly HOSTS_FILE = process.env.HOSTS_FILE_PATH || '/etc/hosts';
  private readonly START_MARKER = '### CI-OS-HUB START ###';
  private readonly END_MARKER = '### CI-OS-HUB END ###';

  constructor(
    private readonly logger: LoggerService,
    @Inject(APP_ASYNC_MUTEX) private readonly mutex: AsyncMutex,
  ) {}

  async addDomain(domain: string, ip = '127.0.0.1'): Promise<void> {
    const release = await this.mutex.acquire('hosts-file');
    try {
      this.logger.debug(`Adding domain ${domain} to hosts file`);
      const content = await this.readHostsFile();
      const lines = content.split('\n');
      
      // Check if domain already exists
      const exists = lines.some(line => line.trim().endsWith(domain) && !line.trim().startsWith('#'));
      if (exists) {
        this.logger.debug(`Domain ${domain} already exists in hosts file`);
        return;
      }

      const newEntry = `${ip}\t${domain}`;
      
      // Find our block
      let startIdx = lines.findIndex(line => line.trim() === this.START_MARKER);
      let endIdx = lines.findIndex(line => line.trim() === this.END_MARKER);

      if (startIdx === -1) {
        // Create block at the end
        lines.push('', this.START_MARKER, newEntry, this.END_MARKER, '');
      } else {
        // Insert into existing block
        lines.splice(endIdx, 0, newEntry);
      }

      await this.writeHostsFile(lines.join('\n'));
      this.logger.info(`Added ${domain} to hosts file`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to update hosts file: ${message}. This is expected in a containerized development environment.`);
    } finally {
      release();
    }
  }

  async removeDomain(domain: string): Promise<void> {
    const release = await this.mutex.acquire('hosts-file');
    try {
      this.logger.debug(`Removing domain ${domain} from hosts file`);
      const content = await this.readHostsFile();
      const lines = content.split('\n');

      const newLines = lines.filter(line => {
        const trimmed = line.trim();
        return !(trimmed.endsWith(domain) && !trimmed.startsWith('#'));
      });

      if (lines.length === newLines.length) {
        return;
      }

      await this.writeHostsFile(newLines.join('\n'));
      this.logger.info(`Removed ${domain} from hosts file`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to update hosts file: ${message}`);
    } finally {
      release();
    }
  }

  private async readHostsFile(): Promise<string> {
    return fs.readFile(this.HOSTS_FILE, 'utf-8');
  }

  private async writeHostsFile(content: string): Promise<void> {
    await fs.writeFile(this.HOSTS_FILE, content, 'utf-8');
  }
}
