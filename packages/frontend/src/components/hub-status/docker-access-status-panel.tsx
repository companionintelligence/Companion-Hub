import { useEffect, useState } from 'react';
import { HintText } from '@/components/ui/field-hint/field-hint';
import { DOCKER_DAEMON_HINT } from './hub-status-tooltips';
import { useTranslation } from 'react-i18next';

type DockerAccessState = 'available' | 'permission_denied' | 'daemon_unavailable' | 'not_installed' | 'error';

interface DockerAccessCheck {
  state: DockerAccessState;
  detail?: string | null;
}

function getTauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    return (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } })
      .__TAURI_INTERNALS__.invoke;
  }
  return null;
}

function statusHeadline(state: DockerAccessState, t: (key: string) => string): string {
  switch (state) {
    case 'available':
      return t('DOCKER_STATUS_READY');
    case 'daemon_unavailable':
      return t('DOCKER_STATUS_WAITING_DAEMON');
    case 'not_installed':
      return t('DOCKER_STATUS_NOT_INSTALLED');
    case 'permission_denied':
      return t('DOCKER_STATUS_PERMISSION_REQUIRED');
    case 'error':
      return t('DOCKER_STATUS_CHECK_FAILED');
    default:
      return t('DOCKER_STATUS_CHECKING');
  }
}

const DOCKER_ACCESS_POLL_MS = 2000;

export function DockerAccessStatusPanel() {
  const { t } = useTranslation();
  const [headline, setHeadline] = useState(t('DOCKER_STATUS_WAITING_DAEMON'));
  const [logLines, setLogLines] = useState<string[]>([`[SYSTEM] ${t('DOCKER_STATUS_PROBING_SOCKET')}`]);

  useEffect(() => {
    const invoke = getTauriInvoke();
    if (!invoke) return;

    const poll = async () => {
      try {
        const result = (await invoke('check_docker_access_command')) as DockerAccessCheck;
        setHeadline(statusHeadline(result.state, t));
        const lines: string[] = [`[SYSTEM] ${statusHeadline(result.state, t)}`];
        if (result.detail) {
          for (const line of result.detail.split('\n').filter(Boolean).slice(0, 3)) {
            lines.push(`[SYSTEM] ${line}`);
          }
        } else if (result.state === 'daemon_unavailable') {
          lines.push(`[SYSTEM] ${t('DOCKER_STATUS_NO_ENGINE_SOCKET')}`);
        }
        setLogLines(lines);
      } catch {
        setHeadline(t('DOCKER_STATUS_CHECKING'));
        setLogLines([`[SYSTEM] ${t('DOCKER_STATUS_DIAGNOSTICS_FAILED')}`]);
      }
    };

    void poll();
    const id = setInterval(() => void poll(), DOCKER_ACCESS_POLL_MS);
    return () => clearInterval(id);
  }, [t]);

  return (
    <div className="w-full rounded-lg border border-border/80 bg-muted/20 p-4 space-y-2">
      <div className="flex items-center gap-2 text-sm text-foreground">
        <span className="h-2 w-2 shrink-0 rounded-full bg-primary animate-pulse" aria-hidden />
        <span className="inline-flex items-center">
          <HintText id="docker-daemon-status" hint={DOCKER_DAEMON_HINT}>
            {headline}
          </HintText>
        </span>
      </div>
      <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed">{logLines.join('\n')}</pre>
    </div>
  );
}
