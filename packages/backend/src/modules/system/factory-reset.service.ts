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
import { removeTunnelRegistrationMarker } from '@/modules/registration/tunnel-markers';
import { BearerOrgMembershipCache } from '@/modules/auth/bearer-org-membership.cache';
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

  /**
   * Forward-auth Bearer org-membership verdicts live in a process-local store, not `CacheService`,
   * so `cache.clear()` above does not reach them. Without this a subject cached as allowed seconds
   * before the reset keeps passing forward-auth for the rest of its TTL — on an appliance that has
   * just been unbound from the organisation that vouched for them.
   *
   * Resolved through `ModuleRef` rather than injected because `SystemModule` does not import
   * `AuthModule`, and a reset must not fail if that provider is somehow unavailable.
   */
  private clearBearerOrgMembership(): void {
    try {
      this.moduleRef.get(BearerOrgMembershipCache, { strict: false })?.clear();
    } catch (error) {
      this.logger.warn(`Factory reset could not clear Bearer org-membership verdicts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async execute(): Promise<{ success: true; message: string }> {
    this.logger.warn('Factory reset requested — tearing down apps, wiping data mounts, and clearing Hub state');

    await this.tearDownApps();
    await this.wipeDataMounts();
    await this.wipeDatabase();
    await this.clearRegistrationArtifacts();
    await this.registrationService.resetRegistration({ reason: 'manual' });
    await this.resetSettings();
    this.cache.clear();
    this.clearBearerOrgMembership();

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
      // `api_key` is named rather than left to CASCADE, which reaches it through
      // `created_by_user_id` anyway: a reset has to take every key, and that must not hang on a
      // foreign key. A key acts with its creator's grants, and `RESTART IDENTITY` hands the next
      // account that creator's id, so a key that survived would act as whoever signs in first.
      await this.db.execute(sql`
        TRUNCATE TABLE
          link,
          app,
          port_allocation,
          device_registration,
          app_store,
          api_key,
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

  /**
   * Empty each folder that holds app data, keeping the folder: each is a bind mount, and removing a
   * mount point fails with EBUSY before anything inside it is touched. That is how a reset used to
   * report success with every app backup still on disk.
   *
   * Throws when a folder still has something in it, before the database and the registration are
   * wiped, so the operator can still sign in and run the reset again.
   */
  public async wipeDataMounts(): Promise<void> {
    const { dataDir } = this.configuration.get('directories');
    const targets = [
      APP_DATA_DIR,
      path.join(dataDir, 'apps'),
      path.join(dataDir, 'repos'),
      path.join(dataDir, 'media'),
      path.join(dataDir, 'backups'),
      // Per-app env and compose overrides, which a reinstalled app would pick up again.
      path.join(dataDir, 'user-config'),
    ];
    const notEmptied: string[] = [];

    for (const target of targets) {
      const left = await this.emptyDirectory(target);

      if (left.length > 0) {
        this.logger.error(`Factory reset could not empty ${target}; still there: ${left.slice(0, 10).join(', ')}`);
        notEmptied.push(target);
      }
    }

    if (notEmptied.length > 0) {
      throw new Error(`Factory reset could not empty ${notEmptied.join(', ')}`);
    }
  }

  public async clearRegistrationArtifacts(): Promise<void> {
    const tokenPath = path.join(TUNNEL_DIR, 'token');
    const resolvedEnvPath = path.join(DATA_DIR, 'state', '.env.resolved');

    await fs.promises.unlink(tokenPath).catch(() => undefined);
    // Remove the marker with its token: the desktop app and CLI start the tunnel when both exist.
    await removeTunnelRegistrationMarker().catch((error: unknown) => {
      this.logger.warn(`Factory reset could not remove the tunnel registration marker: ${error instanceof Error ? error.message : String(error)}`);
    });
    await fs.promises.unlink(resolvedEnvPath).catch(() => undefined);
    await clearRegistrationRecoveryArtifacts();
  }

  public async resetSettings(): Promise<void> {
    const settingsPath = path.join(DATA_DIR, 'state', 'settings.json');
    await writeSettingsJsonFile(settingsPath, '{}', this.logger);
  }

  /** Remove everything inside `dirPath`, and return the names of what is still there. */
  private async emptyDirectory(dirPath: string): Promise<string[]> {
    await this.filesystem.createDirectory(dirPath);

    for (const entry of await this.listDirectory(dirPath)) {
      await this.filesystem.removeDirectory(path.join(dirPath, entry));
    }

    return this.listDirectory(dirPath);
  }

  /** `readdir`, with a missing folder read as empty. Any other error is thrown, never read as empty. */
  private async listDirectory(dirPath: string): Promise<string[]> {
    return fs.promises.readdir(dirPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return [];
      }

      throw error;
    });
  }
}
