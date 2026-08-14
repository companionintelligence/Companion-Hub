import fs from 'node:fs';
import path from 'node:path';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { writeSettingsJsonFile } from '@/common/helpers/env-helpers';
import { APP_DATA_DIR, DATA_DIR, TUNNEL_DIR } from '@/common/constants';
import { app } from '@/core/database/drizzle/schema';
import { DATABASE, type Database } from '@/core/database/database.module';
import { CacheService } from '@/core/cache/cache.service';
import { SessionUserCache } from '@/core/cache/session-user.cache';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { UninstallAppCommand } from '@/modules/app-lifecycle/commands/uninstall-app-command';
import { clearRegistrationRecoveryArtifacts } from '@/modules/app-lifecycle/registration-recovery-state';
import { RegistrationService } from '@/modules/registration/registration.service';
import { DOCKERODE } from '@/modules/docker/constants';
import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { asc, sql } from 'drizzle-orm';

@Injectable()
export class FactoryResetService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
    private readonly moduleRef: ModuleRef,
    private readonly filesystem: FilesystemService,
    private readonly configuration: ConfigurationService,
    private readonly cache: CacheService,
    private readonly sessionUserCache: SessionUserCache,
    private readonly logger: LoggerService,
    private readonly registrationService: RegistrationService,
  ) {}

  public async execute(): Promise<{ success: true; message: string }> {
    this.logger.warn('Factory reset requested — tearing down apps, wiping data mounts, and clearing Hub state');

    await this.tearDownApps();
    await this.wipeDataMounts();
    await this.wipeDatabase();
    await this.clearRegistrationArtifacts();
    await this.registrationService.resetRegistration({ reason: 'manual' });
    await this.resetSettings();
    this.cache.clear();

    this.logger.warn('Factory reset complete — Hub is ready for first-operator setup');

    return {
      success: true,
      message: 'Factory reset complete. Sign in again to create the first operator account.',
    };
  }

  public async tearDownApps(): Promise<void> {
    const apps = await this.db.query.app.findMany({ orderBy: asc(app.appName) });
    if (apps.length === 0) {
      return;
    }

    const uninstallCommand = new UninstallAppCommand(this.moduleRef, this.docker, true);

    for (const installedApp of apps) {
      const appUrn = createAppUrn(installedApp.appName, installedApp.appStoreSlug);
      try {
        const result = await uninstallCommand.execute(appUrn);
        if (!result.success) {
          this.logger.warn(`Factory reset: app teardown reported failure for ${appUrn}: ${result.message}`);
        }
      } catch (error) {
        this.logger.warn(`Factory reset: failed to tear down ${appUrn}: ${error}`);
      }
    }
  }

  public async wipeDatabase(): Promise<void> {
    try {
      await this.db.execute(sql`
        TRUNCATE TABLE
          link,
          app,
          port_allocation,
          device_registration,
          app_store,
          "user"
        RESTART IDENTITY CASCADE
      `);
    } finally {
      // In `finally` because the TRUNCATE can commit and still reject on the way back: a wiped
      // user table whose cached DTOs and sessions survived is the worst of both states.
      //
      // This deletes every user row without going through UserRepository, so nothing else drops
      // the cached DTOs. Sessions have to go with them, and they have to go *here*: `execute()`
      // clears the cache only after three more awaits, so a reset that fails partway used to
      // leave a live `ci-hub-sid` behind. `RESTART IDENTITY` then hands the next account the id
      // that cookie names, and it would be admitted as the new operator.
      this.sessionUserCache.invalidate();
      this.cache.clear();
    }
  }

  public async wipeDataMounts(): Promise<void> {
    const { dataDir } = this.configuration.get('directories');
    const targets = [
      APP_DATA_DIR,
      path.join(dataDir, 'apps'),
      path.join(dataDir, 'repos'),
      path.join(dataDir, 'media'),
      path.join(dataDir, 'backups'),
    ];

    for (const target of targets) {
      await this.wipeDirectory(target);
    }
  }

  public async clearRegistrationArtifacts(): Promise<void> {
    const tokenPath = path.join(TUNNEL_DIR, 'token');
    const resolvedEnvPath = path.join(DATA_DIR, 'state', '.env.resolved');

    await fs.promises.unlink(tokenPath).catch(() => undefined);
    await fs.promises.unlink(resolvedEnvPath).catch(() => undefined);
    await clearRegistrationRecoveryArtifacts();
  }

  public async resetSettings(): Promise<void> {
    const settingsPath = path.join(DATA_DIR, 'state', 'settings.json');
    await writeSettingsJsonFile(settingsPath, '{}');
  }

  private async wipeDirectory(dirPath: string): Promise<void> {
    if (await this.filesystem.pathExists(dirPath)) {
      await this.filesystem.removeDirectory(dirPath);
    }
    await this.filesystem.createDirectory(dirPath);
  }
}
