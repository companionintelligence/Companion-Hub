import {
  backupAppMutation,
  deleteAppBackupMutation,
  getAppBackupsOptions,
  getAppBackupsQueryKey,
  restoreAppBackupMutation,
  uploadBackupMutation,
} from '@/api-client/@tanstack/react-query.gen';
import { downloadBackup } from '@/api-client/sdk.gen';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import { downloadResponseAsFile } from '@/modules/settings/containers/log-download';
import type { AppStatus } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Download, RotateCcw, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAppStatus } from '../../helpers/use-app-status';

const PAGE_SIZE = 10;

/** Statuses in which touching the app's files would race a lifecycle operation that is already doing so. */
const BUSY_STATUSES: ReadonlySet<AppStatus> = new Set([
  'installing',
  'uninstalling',
  'updating',
  'resetting',
  'restoring',
  'backing_up',
  'starting',
  'stopping',
  'restarting',
]);

type BackupRow = { id: string; size: number; date: number };

type Pending = { kind: 'backup' } | { kind: 'upload' } | { kind: 'restore'; backup: BackupRow } | { kind: 'delete'; backup: BackupRow };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface AppBackupsCardProps {
  appUrn: string;
  appName: string;
  status: AppStatus;
}

/**
 * An installed app's backups: make one, upload one made elsewhere, and restore, download or delete
 * the ones that are there.
 *
 * The Hub has served all of this since backups existed (list, back up, restore, download, delete,
 * upload) but the page offered only a "back up first" switch on the update screen, so a backup
 * could be taken and never found again. Backing up stops the app and restoring replaces its data, so
 * both ask first, and nothing here is offered while another operation is already working on the app.
 */
export const AppBackupsCard = ({ appUrn, appName, status }: AppBackupsCardProps) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { setOptimisticStatus } = useAppStatus();
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState<Pending | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  const backups = useQuery({
    ...getAppBackupsOptions({ path: { urn: appUrn }, query: { page, pageSize: PAGE_SIZE } }),
    placeholderData: keepPreviousData,
  });

  const refreshList = useCallback(
    () => queryClient.invalidateQueries({ queryKey: getAppBackupsQueryKey({ path: { urn: appUrn } }) }),
    [queryClient, appUrn],
  );

  // A backup or restore runs in the background and reports over SSE, which updates the app's status. Its
  // end is the moment the list has changed, so that is when to look again.
  const previousStatus = useRef(status);
  useEffect(() => {
    const wasWorking = previousStatus.current === 'backing_up' || previousStatus.current === 'restoring';
    previousStatus.current = status;

    if (wasWorking && status !== 'backing_up' && status !== 'restoring') {
      void refreshList();
    }
  }, [status, refreshList]);

  const onError = (error: TranslatableError) => {
    toast.error(t(error.message, error.intlParams));
    setPending(null);
  };

  const backup = useMutation({
    ...backupAppMutation(),
    onMutate: () => {
      setOptimisticStatus('backing_up', appUrn);
      setPending(null);
    },
    onError,
  });

  const restore = useMutation({
    ...restoreAppBackupMutation(),
    onMutate: () => {
      setOptimisticStatus('restoring', appUrn);
      setPending(null);
    },
    onError,
  });

  const remove = useMutation({
    ...deleteAppBackupMutation(),
    onSuccess: () => {
      toast.success(t('BACKUPS_LIST_DELETE_SUCCESS'));
      setPending(null);
      void refreshList();
    },
    onError,
  });

  const upload = useMutation({
    ...uploadBackupMutation(),
    onSuccess: () => {
      toast.success(t('APP_BACKUP_UPLOAD_SUCCESS'));
      setPending(null);
      setFile(null);
      void refreshList();
    },
    onError: (error: Error) => {
      // The server reports a name clash as a plain message; say so in the person's language.
      toast.error(
        error.message === 'A backup with this filename already exists' ? t('APP_BACKUP_UPLOAD_ALREADY_EXISTS') : t('APP_BACKUP_UPLOAD_ERROR'),
      );
    },
  });

  const download = async (row: BackupRow) => {
    setDownloading(row.id);
    try {
      const result = await downloadBackup({ path: { urn: appUrn, filename: row.id }, parseAs: 'stream' });
      if (!result.response?.ok) {
        throw new Error(`Backup download failed with status ${result.response?.status ?? 'unknown'}`);
      }
      await downloadResponseAsFile(result.response, row.id);
    } catch {
      toast.error(t('BACKUPS_LIST_DOWNLOAD_ERROR'));
    } finally {
      setDownloading(null);
    }
  };

  const busy = BUSY_STATUSES.has(status);
  const rows = backups.data?.data ?? [];
  const lastPage = Math.max(1, backups.data?.lastPage ?? 1);
  const formatDate = (date: number) => new Date(date).toLocaleString();
  const closeDialog = (open: boolean) => {
    if (!open) {
      setPending(null);
      setFile(null);
    }
  };

  return (
    <Card className="border-border/60 bg-card/80 shadow-sm" data-testid="app-backups-card">
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Archive className="size-5" aria-hidden="true" />
          {t('COMMON_BACKUPS')}
          {backups.data ? <span className="text-sm font-normal text-muted-foreground">({backups.data.total})</span> : null}
        </CardTitle>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setPending({ kind: 'upload' })}>
            <Upload className="mr-2 size-4" aria-hidden="true" />
            {t('COMMON_UPLOAD_BACKUP')}
          </Button>
          <Button type="button" size="sm" disabled={busy} onClick={() => setPending({ kind: 'backup' })}>
            <Archive className="mr-2 size-4" aria-hidden="true" />
            {t('BACKUPS_LIST_BACKUP_NOW')}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {backups.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {t('BACKUPS_LIST_LOAD_ERROR')}
          </p>
        ) : rows.length === 0 && !backups.isLoading ? (
          <p className="py-4 text-sm text-muted-foreground">{t('BACKUPS_LIST_EMPTY')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('BACKUPS_LIST_ROW_TITLE_ID')}</TableHead>
                <TableHead>{t('BACKUPS_LIST_ROW_TITLE_DATE')}</TableHead>
                <TableHead>{t('BACKUPS_LIST_ROW_TITLE_SIZE')}</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">{t('BACKUPS_LIST_ROW_TITLE_ACTIONS')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} data-testid={`backup-row-${row.id}`}>
                  <TableCell className="max-w-[16rem] truncate font-mono text-xs" title={row.id}>
                    {row.id}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(row.date)}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatBytes(row.size)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`${t('APP_BACKUP_DOWNLOAD')} ${row.id}`}
                        loading={downloading === row.id}
                        onClick={() => void download(row)}
                      >
                        <Download className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`${t('COMMON_RESTORE')} ${row.id}`}
                        disabled={busy}
                        onClick={() => setPending({ kind: 'restore', backup: row })}
                      >
                        <RotateCcw className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`${t('COMMON_DELETE')} ${row.id}`}
                        disabled={busy}
                        onClick={() => setPending({ kind: 'delete', backup: row })}
                      >
                        <Trash2 className="size-4 text-destructive" aria-hidden="true" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {lastPage > 1 ? (
          <div className="mt-3 flex items-center justify-between gap-2">
            <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
              {t('BACKUPS_LIST_PREVIOUS')}
            </Button>
            <span className="text-sm text-muted-foreground">{t('BACKUPS_LIST_PAGE', { page, total: lastPage })}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page >= lastPage}
              onClick={() => setPage((current) => Math.min(lastPage, current + 1))}
            >
              {t('BACKUPS_LIST_NEXT')}
            </Button>
          </div>
        ) : null}
      </CardContent>

      <Dialog open={pending !== null} onOpenChange={closeDialog}>
        {pending?.kind === 'backup' && (
          <DialogContent size="sm">
            <DialogHeader>
              <DialogTitle>{t('APP_BACKUP_TITLE', { name: appName })}</DialogTitle>
            </DialogHeader>
            <DialogDescription className="py-2">{t('APP_BACKUP_SUBTITLE')}</DialogDescription>
            <DialogFooter>
              <Button loading={backup.isPending} onClick={() => backup.mutate({ path: { urn: appUrn } })}>
                {t('COMMON_BACKUP')}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}

        {pending?.kind === 'restore' && (
          <DialogContent type="danger" size="sm">
            <DialogHeader>
              <DialogTitle>{t('APP_RESTORE_TITLE', { name: appName })}</DialogTitle>
            </DialogHeader>
            <DialogDescription className="space-y-2 py-2">
              <span className="block break-all">{t('APP_RESTORE_WARNING', { id: pending.backup.id, date: formatDate(pending.backup.date) })}</span>
              <span className="block">{t('APP_RESTORE_SUBTITLE')}</span>
            </DialogDescription>
            <DialogFooter>
              <Button
                intent="danger"
                loading={restore.isPending}
                onClick={() => restore.mutate({ path: { urn: appUrn }, body: { filename: pending.backup.id } })}
              >
                {t('COMMON_RESTORE')}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}

        {pending?.kind === 'delete' && (
          <DialogContent type="danger" size="sm">
            <DialogHeader>
              <DialogTitle>{t('DELETE_BACKUP_MODAL_TITLE')}</DialogTitle>
            </DialogHeader>
            <DialogDescription className="space-y-2 py-2">
              <span className="block break-all">
                {t('DELETE_BACKUP_MODAL_WARNING', { id: pending.backup.id, date: formatDate(pending.backup.date) })}
              </span>
              <span className="block">{t('DELETE_BACKUP_MODAL_SUBTITLE')}</span>
            </DialogDescription>
            <DialogFooter>
              <Button
                intent="danger"
                loading={remove.isPending}
                onClick={() => remove.mutate({ path: { urn: appUrn }, body: { filename: pending.backup.id } })}
              >
                {t('COMMON_DELETE')}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}

        {pending?.kind === 'upload' && (
          <DialogContent size="sm">
            <DialogHeader>
              <DialogTitle>{t('COMMON_UPLOAD_BACKUP')}</DialogTitle>
            </DialogHeader>
            <DialogDescription className="py-2">{t('APP_BACKUP_UPLOAD_SUBTITLE')}</DialogDescription>
            <div className="space-y-2">
              <label htmlFor="backup-file" className="text-sm font-medium">
                {t('APP_BACKUP_UPLOAD_FILE_LABEL')}
              </label>
              <input
                id="backup-file"
                type="file"
                accept=".tar.gz,.gz,application/gzip,application/x-gzip"
                className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-muted file:px-3 file:py-1.5"
                onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
              />
              {file && !file.name.endsWith('.tar.gz') ? (
                <p className="text-[0.8rem] font-medium text-destructive" role="alert">
                  {t('APP_BACKUP_UPLOAD_FILE_PLACEHOLDER')}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                loading={upload.isPending}
                disabled={!file?.name.endsWith('.tar.gz')}
                onClick={() => file && upload.mutate({ path: { urn: appUrn }, body: { file } })}
              >
                {t('APP_BACKUP_UPLOAD_SUBMIT')}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </Card>
  );
};
