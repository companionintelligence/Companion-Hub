import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { BackupTools } from '../../tools/backup.tools';

describe('BackupTools', () => {
  let tools: BackupTools;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BackupTools],
    }).compile();

    tools = module.get<BackupTools>(BackupTools);
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  // --- BK-1: hub_backup_app ---

  describe('hub_backup_app', () => {
    // S-BK-1.1: enqueues backup and returns { requestId }
    it.todo('should enqueue a backup and return requestId');
    it.todo('should require appUrn parameter');
  });

  // --- BK-2: hub_restore_app_backup ---

  describe('hub_restore_app_backup', () => {
    // S-BK-2.1: enqueues restore and returns { requestId }
    it.todo('should enqueue a restore and return requestId');

    // S-BK-2.2: non-existent filename returns error
    it.todo('should return error when backup filename does not exist');
  });

  // --- BK-3: hub_list_app_backups ---

  describe('hub_list_app_backups', () => {
    // S-BK-3.1: returns { data, total, currentPage, lastPage }
    it.todo('should return paginated backup list with data, total, currentPage, lastPage');
    it.todo('should return backup entries with id, size, date fields');

    // S-BK-3.2: page defaults to 0, pageSize defaults to 10
    it.todo('should default page to 0');
    it.todo('should default pageSize to 10');
  });

  // --- BK-4: hub_delete_backup ---

  describe('hub_delete_backup', () => {
    // S-BK-4.1: deletes backup file and returns { success: true }
    it.todo('should delete the backup file and return success');
    it.todo('should require appUrn and filename parameters');
  });
});
