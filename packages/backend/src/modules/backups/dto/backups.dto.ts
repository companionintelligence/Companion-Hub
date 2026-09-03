import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

const backupSchema = z.object({
  id: z.string(),
  size: z.number(),
  date: z.number(),
});

const restoreAppBackupSchema = z.object({
  filename: z.string(),
});

const getAppBackupsSchema = z.object({
  data: z.array(backupSchema),
  total: z.number(),
  currentPage: z.number(),
  lastPage: z.number(),
});

const getAppBackupsQuerySchema = z.object({
  page: z.union([z.number().int(), z.string().transform(Number)]).optional(),
  pageSize: z.union([z.number().int(), z.string().transform(Number)]).optional(),
});

const deleteAppBackupBodySchema = z.object({
  filename: z.string(),
});

const backupRequestSchema = z.object({
  requestId: z.string().uuid(),
});

export class RestoreAppBackupDto extends createZodDto(restoreAppBackupSchema) {}
export class GetAppBackupsDto extends createZodDto(getAppBackupsSchema) {}
export class GetAppBackupsQueryDto extends createZodDto(getAppBackupsQuerySchema) {}
export class DeleteAppBackupBodyDto extends createZodDto(deleteAppBackupBodySchema) {}
export class BackupRequestDto extends createZodDto(backupRequestSchema) {}
