import { Injectable, type OnModuleInit } from '@nestjs/common';
import { BackupsService } from '@/modules/backups/backups.service';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { mcpCallerLifecycleActor } from '../mcp-tool-call';
import { McpToolRegistry } from '../mcp-tool-registry.service';

const urnProp = { type: 'string', description: 'App identifier in appName:storeSlug format' } as const;

@Injectable()
export class BackupTools implements OnModuleInit {
  constructor(
    private readonly backupsService: BackupsService,
    private readonly registry: McpToolRegistry,
  ) {}

  onModuleInit() {
    this.registry.register({
      category: 'Backups',
      name: 'hub_backup_app',
      access: 'write',
      description: 'Create a backup of an app. Returns a requestId.',
      inputSchema: { type: 'object', properties: { appUrn: urnProp }, required: ['appUrn'] },
      handler: (p) => this.backupApp(p as { appUrn: string }),
    });
    this.registry.register({
      category: 'Backups',
      name: 'hub_restore_app_backup',
      access: 'write',
      destructive: true, // ISSUE-MCP-2: irreversibly overwrites the app's live data with the snapshot.
      description: 'Restore an app from a named backup file. Returns a requestId.',
      inputSchema: {
        type: 'object',
        properties: { appUrn: urnProp, filename: { type: 'string', description: 'Backup filename to restore' } },
        required: ['appUrn', 'filename'],
      },
      handler: (p) => this.restoreAppBackup(p as { appUrn: string; filename: string }),
    });
    this.registry.register({
      category: 'Backups',
      name: 'hub_list_app_backups',
      access: 'read',
      description: 'List available backups for an app with pagination.',
      inputSchema: {
        type: 'object',
        properties: {
          appUrn: urnProp,
          page: { type: 'number', description: 'Page number (default 0)' },
          pageSize: { type: 'number', description: 'Items per page (default 10)' },
        },
        required: ['appUrn'],
      },
      handler: (p) => this.listAppBackups(p as { appUrn: string; page?: number; pageSize?: number }),
    });
    this.registry.register({
      category: 'Backups',
      name: 'hub_delete_backup',
      access: 'write',
      destructive: true, // ISSUE-MCP-2: permanently deletes a backup file.
      description: 'Delete a backup file for an app.',
      inputSchema: {
        type: 'object',
        properties: { appUrn: urnProp, filename: { type: 'string', description: 'Backup filename to delete' } },
        required: ['appUrn', 'filename'],
      },
      handler: (p) => this.deleteBackup(p as { appUrn: string; filename: string }),
    });
  }

  /*
   * Each call names its actor through `mcpCallerLifecycleActor`, for the verb the backup routes
   * assert, and `BackupsService` asks the lifecycle's gate with it (CI-Hub#1397).
   */
  async backupApp(params: { appUrn: string }) {
    return this.backupsService.backupApp({ appUrn: castAppUrn(params.appUrn), actor: mcpCallerLifecycleActor('backup') });
  }
  async restoreAppBackup(params: { appUrn: string; filename: string }) {
    return this.backupsService.restoreApp({
      appUrn: castAppUrn(params.appUrn),
      filename: params.filename,
      actor: mcpCallerLifecycleActor('restore'),
    });
  }
  async listAppBackups(params: { appUrn: string; page?: number; pageSize?: number }) {
    return this.backupsService.getAppBackups({
      appUrn: castAppUrn(params.appUrn),
      page: params.page ?? 0,
      pageSize: params.pageSize ?? 10,
      actor: mcpCallerLifecycleActor('view'),
    });
  }
  async deleteBackup(params: { appUrn: string; filename: string }) {
    await this.backupsService.deleteAppBackup({
      appUrn: castAppUrn(params.appUrn),
      filename: params.filename,
      actor: mcpCallerLifecycleActor('backup'),
    });
    return { success: true };
  }
}
