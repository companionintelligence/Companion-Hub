import { Injectable } from '@nestjs/common';
import { BackupsService } from '@/modules/backups/backups.service';
import { castAppUrn } from '@/common/helpers/app-helpers';

@Injectable()
export class BackupTools {
  constructor(private readonly backupsService: BackupsService) {}

  async backupApp(params: { appUrn: string }) {
    return this.backupsService.backupApp({ appUrn: castAppUrn(params.appUrn) });
  }

  async restoreAppBackup(params: { appUrn: string; filename: string }) {
    return this.backupsService.restoreApp({
      appUrn: castAppUrn(params.appUrn),
      filename: params.filename,
    });
  }

  async listAppBackups(params: { appUrn: string; page?: number; pageSize?: number }) {
    return this.backupsService.getAppBackups({
      appUrn: castAppUrn(params.appUrn),
      page: params.page ?? 0,
      pageSize: params.pageSize ?? 10,
    });
  }

  async deleteBackup(params: { appUrn: string; filename: string }) {
    await this.backupsService.deleteAppBackup({
      appUrn: castAppUrn(params.appUrn),
      filename: params.filename,
    });
    return { success: true };
  }
}
