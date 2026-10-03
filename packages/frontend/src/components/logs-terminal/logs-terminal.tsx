import { InputGroup } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { colorizeLogLine } from '@/lib/log-ansi';
import { useResolvedTheme } from '@/lib/use-resolved-theme';
import { cn } from '@/lib/utils';
import { useLocalStorage } from '@uidotdev/usehooks';
import DOMPurify from 'dompurify';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './logs-terminal.css';

/** Wait until typing pauses before the buffer and the log stream adopt a new length. */
export const MAX_LINES_SETTLE_MS = 400;

type Props = {
  logs: { id: number; text: string }[];
  maxLines: number;
  onMaxLinesChange: (lines: number) => void;
  toolbarActions?: ReactNode;
  fullHeight?: boolean;
  className?: string;
};

export const LogsTerminal = (props: Props) => {
  const { t } = useTranslation();

  const { logs, onMaxLinesChange, maxLines, toolbarActions, fullHeight = false, className } = props;
  const [follow, setFollow] = useLocalStorage<boolean>('logs-follow', true);
  const [wrapLines, setWrapLines] = useLocalStorage<boolean>('logs-wraplines', false);
  const resolvedTheme = useResolvedTheme();
  const ref = useRef<HTMLPreElement>(null);

  const renderedLogs = useMemo(
    () => logs.map((log) => DOMPurify.sanitize(colorizeLogLine(log.text, resolvedTheme))).join('<br />'),
    [logs, resolvedTheme],
  );

  const [draft, setDraft] = useState(String(maxLines));
  const editing = useRef(false);
  const settleTimer = useRef<number | null>(null);

  const lastLogId = logs.length > 0 ? logs.at(-1)?.id : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: necessary to update the scroll when a new log is added
  useEffect(() => {
    if (ref.current && follow) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [lastLogId, follow]);

  useEffect(() => {
    if (!editing.current) setDraft(String(maxLines));
  }, [maxLines]);

  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    },
    [],
  );

  const commitMaxLines = (raw: string) => {
    if (settleTimer.current !== null) {
      window.clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    editing.current = false;
    const parsed = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(String(maxLines));
      return;
    }

    // Whole lines only: a typed "2.5" would otherwise be stored and later used as a slice offset.
    const linesToKeep = Math.max(1, Math.trunc(parsed));
    setDraft(String(linesToKeep));
    onMaxLinesChange(linesToKeep);
  };

  const scheduleMaxLines = (raw: string) => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      commitMaxLines(raw);
    }, MAX_LINES_SETTLE_MS);
  };

  return (
    <div className={cn('flex w-full flex-col', fullHeight && 'h-full min-h-0', className)}>
      <div className="mb-3 flex flex-wrap items-center gap-4">
        <Switch name="follow-logs" checked={follow} onCheckedChange={() => setFollow(!follow)} label={t('APP_LOGS_TAB_FOLLOW')} />
        <Switch name="wrap-lines" checked={wrapLines} onCheckedChange={() => setWrapLines(!wrapLines)} label={t('APP_LOGS_TAB_WRAP_LINES')} />
        <div className="ml-auto flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
          {toolbarActions ? <div className="flex items-center gap-2 sm:justify-end">{toolbarActions}</div> : null}
          <div className="w-full sm:w-48">
            <InputGroup
              id="max-lines"
              size="sm"
              groupPrefix={t('APP_LOGS_TAB_MAX_LINES')}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={draft}
              onChange={(e) => {
                const raw = e.currentTarget.value;
                editing.current = true;
                setDraft(raw);
                if (raw.trim() === '' || !Number.isFinite(Number(raw))) {
                  if (settleTimer.current !== null) {
                    window.clearTimeout(settleTimer.current);
                    settleTimer.current = null;
                  }
                  return;
                }
                scheduleMaxLines(raw);
              }}
              onBlur={(e) => commitMaxLines(e.currentTarget.value)}
            />
          </div>
        </div>
      </div>
      <pre
        id="log-terminal"
        className={cn('mt-2 log-terminal', fullHeight && 'log-terminal--full-height min-h-0 flex-1', wrapLines && 'wrap-lines')}
        ref={ref}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: safe to use because the content is sanitized
        dangerouslySetInnerHTML={{ __html: renderedLogs }}
      />
    </div>
  );
};
