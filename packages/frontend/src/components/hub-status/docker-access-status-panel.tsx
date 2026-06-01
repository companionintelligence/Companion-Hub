import { useEffect, useState } from 'react';
import { HintText } from '@/components/ui/field-hint/field-hint';
import { DOCKER_DAEMON_HINT } from './hub-status-tooltips';

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

function statusHeadline(state: DockerAccessState): string {
  switch (state) {
    case 'available':
      return 'Docker is ready';
    case 'daemon_unavailable':
      return 'Waiting for Docker daemon…';
    case 'not_installed':
      return 'Docker is not installed';
    case 'permission_denied':
      return 'Docker permission required';
    case 'error':
      return 'Docker check failed';
    default:
      return 'Checking Docker…';
  }
}

const DOCKER_ACCESS_POLL_MS = 2000;

export function DockerAccessStatusPanel() {
  const [headline, setHeadline] = useState('Waiting for Docker daemon…');
  const [logLines, setLogLines] = useState<string[]>(['[SYSTEM] Probing for Docker socket…']);

  useEffect(() => {
    const invoke = getTauriInvoke();
    if (!invoke) return;

    const poll = async () => {
      try {
        const result = (await invoke('check_docker_access_command')) as DockerAccessCheck;
        setHeadline(statusHeadline(result.state));
        const lines: string[] = [`[SYSTEM] ${statusHeadline(result.state)}`];
        if (result.detail) {
          for (const line of result.detail.split('\n').filter(Boolean).slice(0, 3)) {
            lines.push(`[SYSTEM] ${line}`);
          }
        } else if (result.state === 'daemon_unavailable') {
          lines.push('[SYSTEM] No container engine found at /var/run/docker.sock');
        }
        setLogLines(lines);
      } catch {
        setHeadline('Checking Docker…');
        setLogLines(['[SYSTEM] Could not run Docker diagnostics']);
      }
    };

    void poll();
    const id = setInterval(() => void poll(), DOCKER_ACCESS_POLL_MS);
    return () => clearInterval(id);
  }, []);

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
