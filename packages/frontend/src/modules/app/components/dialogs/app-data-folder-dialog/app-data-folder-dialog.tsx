import { client } from '@/api-client/client.gen';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { copyToClipboard } from '@/lib/copy-to-clipboard';
import type { AppInfo } from '@/types/app.types';
import { useQuery } from '@tanstack/react-query';
import { Copy, File, Folder } from 'lucide-react';
import type React from 'react';
import { useTranslation } from 'react-i18next';

type AppDataListingEntry = {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  sizeBytes: number | null;
};

type AppDataListing = {
  hostPath: string | null;
  rootExists: boolean;
  truncated: boolean;
  entries: AppDataListingEntry[];
};

interface IProps {
  info: AppInfo;
  isOpen: boolean;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function depthOf(relativePath: string): number {
  if (!relativePath) return 0;
  return relativePath.split('/').length - 1;
}

export const AppDataFolderDialog: React.FC<IProps> = ({ info, isOpen, onClose }) => {
  const { t } = useTranslation();

  const listing = useQuery({
    queryKey: ['app-data-files', info.urn],
    queryFn: async () => {
      const { data, error } = await client.get({
        url: `/api/apps/${encodeURIComponent(info.urn)}/data-files`,
      });
      if (error) {
        throw error;
      }
      return data as AppDataListing;
    },
    enabled: isOpen,
    staleTime: 15_000,
  });

  const entries = listing.data?.entries ?? [];
  const hostPath = listing.data?.hostPath ?? null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t('APP_DATA_FOLDER_DIALOG_TITLE', { name: info.name })}</DialogTitle>
        </DialogHeader>
        <DialogDescription className="space-y-3 text-left">
          <p className="text-sm text-muted-foreground">{t('APP_DATA_FOLDER_DIALOG_DESC')}</p>
          {hostPath ? (
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2">
              <code className="min-w-0 flex-1 break-all text-xs text-foreground">{hostPath}</code>
              <Button
                type="button"
                size="sm"
                intent="light"
                className="shrink-0"
                onClick={() => copyToClipboard(hostPath, t('APP_ACTION_DATA_FOLDER_PATH_COPIED'))}
                aria-label={t('APP_ACTION_COPY_DATA_FOLDER_PATH')}
              >
                <Copy className="size-4" />
              </Button>
            </div>
          ) : null}

          <div className="max-h-[min(24rem,50vh)] overflow-y-auto rounded-md border" data-testid="app-data-folder-listing">
            {listing.isLoading ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">{t('APP_DATA_FOLDER_DIALOG_LOADING')}</div>
            ) : listing.isError ? (
              <div className="px-3 py-6 text-center text-sm text-destructive">{t('APP_DATA_FOLDER_DIALOG_ERROR')}</div>
            ) : !listing.data?.rootExists || entries.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">{t('APP_DATA_FOLDER_DIALOG_EMPTY')}</div>
            ) : (
              <ul className="divide-y">
                {entries.map((entry) => {
                  const Icon = entry.kind === 'directory' ? Folder : File;
                  const depth = depthOf(entry.path);
                  return (
                    <li key={entry.path} className="flex items-center gap-2 px-3 py-1.5 text-sm" style={{ paddingLeft: `${0.75 + depth * 0.75}rem` }}>
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.name}</span>
                      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                        {entry.kind === 'directory' ? t('APP_DATA_FOLDER_DIALOG_DIR') : entry.sizeBytes === null ? '—' : formatBytes(entry.sizeBytes)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {listing.data?.truncated ? <p className="text-xs text-muted-foreground">{t('APP_DATA_FOLDER_DIALOG_TRUNCATED')}</p> : null}
        </DialogDescription>
        <DialogFooter>
          <Button onClick={onClose}>{t('COMMON_CLOSE')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
