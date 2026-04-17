import { Button } from '@/components/ui/Button';
import { apiFetch } from '@/lib/api-fetch';
import { useSSE } from '@/lib/hooks/use-sse';
import { Download } from 'lucide-react';
import { Suspense, lazy, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { downloadResponseAsFile } from './log-download';

const LogsTerminal = lazy(() => import('@/components/logs-terminal/logs-terminal').then((module) => ({ default: module.LogsTerminal })));

export const LogsContainer = () => {
  const { t } = useTranslation();
  let nextId = 0;
  const [logs, setLogs] = useState<{ id: number; text: string }[]>([]);
  const [isDownloading, setIsDownloading] = useState(false);
  const maxLines = useRef(300);

  useSSE({
    topic: 'ci-hub-logs',
    params: new URLSearchParams({ maxLines: maxLines.current.toString() }),
    onEvent: (data) => {
      setLogs((prevLogs) => {
        if (!data.lines) {
          return prevLogs;
        }
        const newLogs = [...prevLogs, ...data.lines.map((line) => ({ id: nextId++, text: line.trim() }))];
        if (newLogs.length > maxLines.current) {
          return newLogs.slice(newLogs.length - maxLines.current);
        }
        return newLogs;
      });
    },
  });

  const updateMaxLines = (lines: number) => {
    const linesToKeep = Math.max(1, lines);
    maxLines.current = linesToKeep;
    setLogs((currentLogs) => currentLogs.slice(currentLogs.length - linesToKeep));
  };

  const downloadHubLogs = async () => {
    try {
      setIsDownloading(true);
      const response = await apiFetch('/api/system/logs/download');

      if (!response.ok) {
        throw new Error(`Hub log download failed with status ${response.status}`);
      }

      await downloadResponseAsFile(response, 'ci-hub-logs.log');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('SETTINGS_LOGS_DOWNLOAD_ERROR', 'Failed to download logs.'));
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Suspense>
        <LogsTerminal
          logs={logs}
          maxLines={maxLines.current}
          onMaxLinesChange={updateMaxLines}
          fullHeight
          className="flex-1 min-h-0"
          toolbarActions={
            <Button type="button" variant="outline" size="sm" className="gap-2" onClick={downloadHubLogs} loading={isDownloading}>
              {isDownloading ? null : <Download className="size-4" />}
              {t('SETTINGS_LOGS_DOWNLOAD', 'Download full logs')}
            </Button>
          }
        />
      </Suspense>
      <div className="mt-4 text-center text-muted-foreground">
        Powered by Docker, Node, React, TypeScript, PostgreSQL, Ubuntu, Debian, and many other OSS projects we love. See release notes for details.
      </div>
    </div>
  );
};
