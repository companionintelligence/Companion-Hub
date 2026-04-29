import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { McpToolRegistry } from '../../mcp-tool-registry.service';
import { BackupTools } from '../../tools/backup.tools';
import { BackupsService } from '@/modules/backups/backups.service';

describe('BackupTools', () => {
  let tools: BackupTools;
  let backupsService: MockProxy<BackupsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupTools,
        { provide: BackupsService, useValue: mock<BackupsService>() },
        { provide: McpToolRegistry, useValue: mock<McpToolRegistry>() },
      ],
    }).compile();
    tools = module.get<BackupTools>(BackupTools);
    backupsService = module.get(BackupsService);
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  describe('hub_backup_app', () => {
    it('should enqueue a backup and return requestId', async () => {
      backupsService.backupApp.mockResolvedValue({ requestId: 'bk-1' });
      const result = await tools.backupApp({ appUrn: 'ci-store:test' });
      expect(result).toEqual({ requestId: 'bk-1' });
    });
  });

  describe('hub_restore_app_backup', () => {
    it('should enqueue a restore and return requestId', async () => {
      backupsService.restoreApp.mockResolvedValue({ requestId: 'rs-1' });
      const result = await tools.restoreAppBackup({ appUrn: 'ci-store:test', filename: 'backup-1.tar.gz' });
      expect(result).toEqual({ requestId: 'rs-1' });
    });
    it('should return error when backup filename does not exist', async () => {
      backupsService.restoreApp.mockRejectedValue(new Error('Backup not found'));
      await expect(tools.restoreAppBackup({ appUrn: 'ci-store:test', filename: 'nonexistent.tar.gz' })).rejects.toThrow();
    });
  });

  describe('hub_list_app_backups', () => {
    it('should return paginated backup list', async () => {
      backupsService.getAppBackups.mockResolvedValue({
        data: [{ id: '1', size: 1024, date: '2024-01-01' }],
        total: 1,
        currentPage: 0,
        lastPage: 0,
      } as any);
      const result = await tools.listAppBackups({ appUrn: 'ci-store:test' });
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });
    it('should default page to 0 and pageSize to 10', async () => {
      backupsService.getAppBackups.mockResolvedValue({ data: [], total: 0, currentPage: 0, lastPage: 0 } as any);
      await tools.listAppBackups({ appUrn: 'ci-store:test' });
      expect(backupsService.getAppBackups).toHaveBeenCalledWith(expect.objectContaining({ page: 0, pageSize: 10 }));
    });
  });

  describe('hub_delete_backup', () => {
    it('should delete the backup file and return success', async () => {
      backupsService.deleteAppBackup.mockResolvedValue(undefined);
      const result = await tools.deleteBackup({ appUrn: 'ci-store:test', filename: 'backup-1.tar.gz' });
      expect(result).toEqual({ success: true });
    });
  });
});
