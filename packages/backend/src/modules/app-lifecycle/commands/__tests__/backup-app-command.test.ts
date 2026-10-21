import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { mock, mockDeep } from 'vitest-mock-extended';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { BackupManager } from '@/modules/backups/backup.manager';
import { DockerService } from '@/modules/docker/docker.service';
import type { AppUrn } from '@ci-hub/common/types';
import { BackupAppCommand } from '../backup-app-command';

describe('BackupAppCommand', () => {
  const appUrn = 'kimai:ci-marketplace' as AppUrn;
  let docker: ReturnType<typeof mock<DockerService>>;
  let backups: ReturnType<typeof mock<BackupManager>>;
  let command: BackupAppCommand;

  beforeEach(() => {
    docker = mock<DockerService>();
    docker.composeApp.mockResolvedValue(undefined as never);
    backups = mock<BackupManager>();
    backups.backupApp.mockResolvedValue({ filename: 'kimai.tar.gz' });
    const config = mock<ConfigurationService>();
    config.get.mockReturnValue({ maxBackups: 0 } as never);
    const services = new Map<unknown, unknown>([
      [LoggerService, mockDeep<LoggerService>()],
      [DockerService, docker],
      [BackupManager, backups],
      [AppsRepository, mock<AppsRepository>()],
      [ConfigurationService, config],
    ]);
    const moduleRef = mock<ModuleRef>();
    moduleRef.get.mockImplementation(((token: unknown) => services.get(token)) as never);
    command = new BackupAppCommand(moduleRef, {} as Dockerode);
  });

  it('checks the backup can be made, then stops the app and backs it up', async () => {
    await expect(command.execute(appUrn)).resolves.toMatchObject({ success: true });

    expect(backups.assertBackupPossible.mock.invocationCallOrder[0]).toBeLessThan(docker.composeApp.mock.invocationCallOrder[0] as number);
    expect(backups.backupApp).toHaveBeenCalledWith(appUrn);
  });

  // Kimai's database is the case: the Hub cannot read it, and the helper that can is not available.
  it('does not stop the app for a backup that cannot be made', async () => {
    backups.assertBackupPossible.mockRejectedValue(new Error(`Cannot back up ${appUrn}: … Nothing was stopped.`));

    await expect(command.execute(appUrn)).resolves.toMatchObject({ success: false });

    expect(docker.composeApp).not.toHaveBeenCalled();
    expect(backups.backupApp).not.toHaveBeenCalled();
  });
});
