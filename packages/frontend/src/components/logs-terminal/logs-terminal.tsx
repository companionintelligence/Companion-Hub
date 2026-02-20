import { useLocalStorage } from '@uidotdev/usehooks';
import clsx from 'clsx';
import { InputGroup } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import DOMPurify from 'dompurify';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import './logs-terminal.css';

type Props = {
  logs: { id: number; text: string }[];
  maxLines: number;
  onMaxLinesChange: (lines: number) => void;
};

export const LogsTerminal = (props: Props) => {
  const { t } = useTranslation();

  const { logs, onMaxLinesChange, maxLines } = props;
  const [follow, setFollow] = useLocalStorage<boolean>('logs-follow', true);
  const [wrapLines, setWrapLines] = useLocalStorage<boolean>('logs-wraplines', false);
  const ref = useRef<HTMLPreElement>(null);

  const lastLogId = logs.length > 0 ? logs.at(-1)?.id : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: necessary to update the scroll when a new log is added
  useEffect(() => {
    if (ref.current && follow) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [lastLogId, follow]);

  const updateMaxLines = (lines: number) => {
    const linesToKeep = Math.max(1, lines);
    onMaxLinesChange(linesToKeep);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-6 mb-3">
        <Switch name="follow-logs" checked={follow} onCheckedChange={() => setFollow(!follow)} label={t('APP_LOGS_TAB_FOLLOW')} />
        <Switch name="wrap-lines" checked={wrapLines} onCheckedChange={() => setWrapLines(!wrapLines)} label={t('APP_LOGS_TAB_WRAP_LINES')} />
        <div className="ml-auto w-48">
          <InputGroup
            id="max-lines"
            groupPrefix={t('APP_LOGS_TAB_MAX_LINES')}
            type="number"
            value={maxLines}
            onChange={(e) => updateMaxLines(Number.parseInt(e.target.value, 10))}
          />
        </div>
      </div>
      <pre
        id="log-terminal"
        className={clsx('mt-2 log-terminal', {
          'wrap-lines': wrapLines,
        })}
        ref={ref}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: safe to use because the content is sanitized
        dangerouslySetInnerHTML={{ __html: logs.map((log) => DOMPurify.sanitize(log.text)).join('<br />') }}
      />
    </div>
  );
};
