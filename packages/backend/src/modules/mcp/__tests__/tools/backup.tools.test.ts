import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { LifecycleActorFor } from '@/core/portal/lifecycle-actor';
import { GRANTED_ACTOR, OTHER_APP, asKey } from '@/tests/utils/lifecycle-actor-gate';
import { mcpAdminCallContext } from '../../mcp-call-context';
import { McpToolRegistry } from '../../mcp-tool-registry.service';
import { BackupTools } from '../../tools/backup.tools';
import { BackupsService } from '@/modules/backups/backups.service';

/** A key nobody is recorded as creating: the plainest caller the backup tools act for. */
const asAgent = <T>(call: () => Promise<T>) => asKey({ ownerAppUrn: null, createdByUserId: null }, call);

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
      const result = await asAgent(() => tools.backupApp({ appUrn: 'ci-store:test' }));
      expect(result).toEqual({ requestId: 'bk-1' });
    });
  });

  describe('hub_restore_app_backup', () => {
    it('should enqueue a restore and return requestId', async () => {
      backupsService.restoreApp.mockResolvedValue({ requestId: 'rs-1' });
      const result = await asAgent(() => tools.restoreAppBackup({ appUrn: 'ci-store:test', filename: 'backup-1.tar.gz' }));
      expect(result).toEqual({ requestId: 'rs-1' });
    });
    it('should return error when backup filename does not exist', async () => {
      backupsService.restoreApp.mockRejectedValue(new Error('Backup not found'));
      await expect(asAgent(() => tools.restoreAppBackup({ appUrn: 'ci-store:test', filename: 'nonexistent.tar.gz' }))).rejects.toThrow(
        'Backup not found',
      );
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
      const result = await asAgent(() => tools.listAppBackups({ appUrn: 'ci-store:test' }));
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });
    it('should default page to 0 and pageSize to 10', async () => {
      backupsService.getAppBackups.mockResolvedValue({ data: [], total: 0, currentPage: 0, lastPage: 0 } as any);
      await asAgent(() => tools.listAppBackups({ appUrn: 'ci-store:test' }));
      expect(backupsService.getAppBackups).toHaveBeenCalledWith(expect.objectContaining({ page: 0, pageSize: 10 }));
    });
  });

  describe('hub_delete_backup', () => {
    it('should delete the backup file and return success', async () => {
      backupsService.deleteAppBackup.mockResolvedValue(undefined);
      const result = await asAgent(() => tools.deleteBackup({ appUrn: 'ci-store:test', filename: 'backup-1.tar.gz' }));
      expect(result).toEqual({ success: true });
    });
  });

  /*
   * `BackupsService` asks the lifecycle's actor gate with the actor each tool hands it (CI-Hub#1397).
   * What is pinned here is that the tool names the caller in flight, for the verb its app route asserts.
   */
  describe('the actor handed to BackupsService', () => {
    const appUrn = 'immich:ci-marketplace';
    const filename = 'immich.tar.gz';

    const calls = [
      ['hub_backup_app', 'backup', () => tools.backupApp({ appUrn }), () => backupsService.backupApp],
      ['hub_restore_app_backup', 'restore', () => tools.restoreAppBackup({ appUrn, filename }), () => backupsService.restoreApp],
      ['hub_list_app_backups', 'view', () => tools.listAppBackups({ appUrn }), () => backupsService.getAppBackups],
      ['hub_delete_backup', 'backup', () => tools.deleteBackup({ appUrn, filename }), () => backupsService.deleteAppBackup],
    ] as const;

    beforeEach(() => {
      backupsService.backupApp.mockResolvedValue({ requestId: 'r' });
      backupsService.restoreApp.mockResolvedValue({ requestId: 'r' });
      backupsService.getAppBackups.mockResolvedValue({ data: [], total: 0, currentPage: 1, lastPage: 0 } as never);
      backupsService.deleteAppBackup.mockResolvedValue(undefined);
    });

    it.each(
      calls,
    )('%s hands over the calling key — a managed one with its owning app, which the gate reads to tell its own app from the others', async (_tool, _action, call, service) => {
      await asKey({ ownerAppUrn: OTHER_APP, createdByUserId: null }, call);

      expect(service()).toHaveBeenCalledWith(
        expect.objectContaining({ appUrn, actor: { kind: 'mcp', ownerAppUrn: OTHER_APP, createdByUserId: null } }),
      );
    });

    it.each(calls)('%s hands over the person an admin-runner call names, for %s', async (_tool, action, call, service) => {
      const actorFor = vi.fn<LifecycleActorFor>(() => GRANTED_ACTOR);

      await mcpAdminCallContext.run(actorFor, call);

      expect(actorFor).toHaveBeenCalledWith(action);
      expect(service()).toHaveBeenCalledWith(expect.objectContaining({ appUrn, actor: GRANTED_ACTOR }));
    });

    it.each(calls)('%s refuses a call that names no caller, before it reaches the service', async (_tool, _action, call, service) => {
      await expect(call()).rejects.toThrow('APP_ACTION_GRANT_DENIED');

      expect(service()).not.toHaveBeenCalled();
    });
  });
});
