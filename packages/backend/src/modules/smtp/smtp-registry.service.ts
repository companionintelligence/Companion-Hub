import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { DATA_DIR } from '@/common/constants';

/** Stored credentials for a single app. */
export interface AppSmtpCredentials {
  appName: string;
  username: string;
  password: string;
  createdAt: string;
}

/** Shape of the on-disk registry file. */
interface RegistryFile {
  version: 1;
  apps: Record<string, AppSmtpCredentials>;
}

const REGISTRY_PATH = path.join(DATA_DIR, 'smtp-registry.json');

/**
 * SmtpRegistryService — persists per-app SMTP credentials across Hub restarts.
 * Credentials are stored as a JSON file in the Hub data directory.
 */
@Injectable()
export class SmtpRegistryService {
  private registry: RegistryFile = { version: 1, apps: {} };
  private loaded = false;

  constructor(private readonly logger: LoggerService) {}

  /** Load the registry from disk (idempotent). */
  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.promises.readFile(REGISTRY_PATH, 'utf8');
      this.registry = JSON.parse(raw) as RegistryFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`[SmtpRegistry] Could not read registry file: ${err}`);
      }
      this.registry = { version: 1, apps: {} };
    }
    this.loaded = true;
  }

  /** Persist the current registry to disk. */
  private async save(): Promise<void> {
    try {
      await fs.promises.writeFile(REGISTRY_PATH, JSON.stringify(this.registry, null, 2), 'utf8');
    } catch (err) {
      this.logger.error(`[SmtpRegistry] Failed to save registry: ${err}`);
    }
  }

  /**
   * Return existing credentials for `appName`, or generate and persist new ones.
   */
  async getOrCreateAppCredentials(appName: string): Promise<AppSmtpCredentials> {
    await this.load();

    if (this.registry.apps[appName]) {
      return this.registry.apps[appName] as AppSmtpCredentials;
    }

    const credentials: AppSmtpCredentials = {
      appName,
      username: `${appName}@hub.local`,
      password: randomBytes(24).toString('hex'),
      createdAt: new Date().toISOString(),
    };

    this.registry.apps[appName] = credentials;
    await this.save();

    this.logger.info(`[SmtpRegistry] Generated SMTP credentials for app "${appName}"`);
    return credentials;
  }

  /** Return credentials for `appName` if they exist, or `null`. */
  async getAppCredentials(appName: string): Promise<AppSmtpCredentials | null> {
    await this.load();
    return this.registry.apps[appName] ?? null;
  }

  /** List all registered apps. */
  async listRegisteredApps(): Promise<AppSmtpCredentials[]> {
    await this.load();
    return Object.values(this.registry.apps);
  }

  /** Remove credentials for `appName`. */
  async removeAppCredentials(appName: string): Promise<void> {
    await this.load();
    delete this.registry.apps[appName];
    await this.save();
    this.logger.info(`[SmtpRegistry] Removed SMTP credentials for app "${appName}"`);
  }
}
