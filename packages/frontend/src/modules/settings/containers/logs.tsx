import { Button } from '@/components/ui/Button';
import { downloadHubLogs as downloadHubLogsSdk } from '@/api-client/sdk.gen';
import { useSSE } from '@/lib/hooks/use-sse';
import type { SSE } from '@ci-hub/common/schemas';
import { Download } from 'lucide-react';
import { Suspense, lazy, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { downloadResponseAsFile } from './log-download';

const LogsTerminal = lazy(() => import('@/components/logs-terminal/logs-terminal').then((module) => ({ default: module.LogsTerminal })));

type HubLogEvent = Extract<SSE, { topic: 'ci-hub-logs' }>['data'];
type LogStreamState = 'connecting' | 'open' | 'failed';

/**
 * One EventSource for this visit. Remounting (a new `key`) is how Retry asks the Hub again:
 * `useSSE` opens its stream once per mount.
 */
function HubLogStream({
  maxLines,
  onEvent,
  onOpen,
  onError,
}: {
  maxLines: number;
  onEvent: (data: HubLogEvent) => void;
  onOpen: () => void;
  onError: () => void;
}) {
  const params = useMemo(() => new URLSearchParams({ maxLines: String(maxLines) }), [maxLines]);
  useSSE({
    topic: 'ci-hub-logs',
    params,
    onEvent,
    onOpen,
    onError,
  });
  return null;
}

export const LogsContainer = () => {
  const { t } = useTranslation();
  const nextId = useRef(0);
  const [logs, setLogs] = useState<{ id: number; text: string }[]>([]);
  const [isDownloading, setIsDownloading] = useState(false);
  const [maxLines, setMaxLines] = useState(1000);
  const [stream, setStream] = useState<LogStreamState>('connecting');
  const [attempt, setAttempt] = useState(0);

  const appendLogs = (data: HubLogEvent) => {
    setLogs((prevLogs) => {
      if (!data.lines) {
        return prevLogs;
      }
      const newLogs = [...prevLogs, ...data.lines.map((line) => ({ id: nextId.current++, text: line.trim() }))];
      if (newLogs.length > maxLines) {
        return newLogs.slice(newLogs.length - maxLines);
      }
      return newLogs;
    });
  };

  const updateMaxLines = (lines: number) => {
    const linesToKeep = Math.max(1, lines);
    setMaxLines(linesToKeep);
    setLogs((currentLogs) => currentLogs.slice(currentLogs.length - linesToKeep));
  };

  const downloadHubLogs = async () => {
    try {
      setIsDownloading(true);
      const result = await downloadHubLogsSdk({ parseAs: 'stream' });
      const response = result.response;
      if (!response?.ok) {
        throw new Error(`Hub log download failed with status ${response?.status ?? 'unknown'}`);
      }

      await downloadResponseAsFile(response, 'ci-hub-logs.log');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('SETTINGS_LOGS_DOWNLOAD_ERROR'));
    } finally {
      setIsDownloading(false);
    }
  };

  const downloadButton = (
    <Button type="button" variant="outline" size="sm" className="gap-2" onClick={downloadHubLogs} loading={isDownloading}>
      {isDownloading ? null : <Download className="size-4" />}
      {t('SETTINGS_LOGS_DOWNLOAD', 'Download full logs')}
    </Button>
  );

  const showTerminal = stream === 'open' && logs.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <HubLogStream key={attempt} maxLines={maxLines} onEvent={appendLogs} onOpen={() => setStream('open')} onError={() => setStream('failed')} />
      {showTerminal ? (
        <Suspense>
          <LogsTerminal
            logs={logs}
            maxLines={maxLines}
            onMaxLinesChange={updateMaxLines}
            fullHeight
            className="flex-1 min-h-0"
            toolbarActions={downloadButton}
          />
        </Suspense>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="flex justify-end">{downloadButton}</div>
          {stream === 'failed' ? (
            <div role="alert" className="text-center" data-testid="logs-stream-error">
              <p>{t('SETTINGS_LOGS_STREAM_ERROR')}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => {
                  setStream('connecting');
                  setAttempt((current) => current + 1);
                }}
              >
                {t('COMMON_RETRY')}
              </Button>
            </div>
          ) : (
            <p role="status" className="text-center text-muted-foreground" data-testid="logs-stream-status">
              {stream === 'connecting' ? t('SETTINGS_LOGS_CONNECTING') : t('SETTINGS_LOGS_EMPTY')}
            </p>
          )}
        </div>
      )}
      <div className="mt-4 text-center text-muted-foreground">{t('SETTINGS_LOGS_POWERED_BY')}</div>
    </div>
  );
};
