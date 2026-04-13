import { onCleanup, type ParentComponent } from 'solid-js';
import { toast } from '@/stores/toast-store';
import { extractAppUrn } from '@/lib/utils';
import { getTauriSessionId } from '@/api-client';

export const SSEProvider: ParentComponent = (props) => {
  let eventSource: EventSource | null = null;
  let retries = 0;

  const initializeSSE = () => {
    const baseUrl = window.location.origin;
    const url = new URL(`${baseUrl}/api/sse/app`);

    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (isTauri) {
      const sid = getTauriSessionId();
      if (sid) url.searchParams.set('session_id', sid);
    }

    eventSource = new EventSource(url);

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        handleEvent(data);
      } catch (error) {
        console.error('Failed to parse SSE message:', error);
      }
    };

    eventSource.onopen = () => {
      retries = 0;
    };

    eventSource.onerror = () => {
      eventSource?.close();
      eventSource = null;
      if (retries < 5) {
        retries++;
        setTimeout(initializeSSE, 2 ** retries * 1000);
      }
    };
  };

  const handleEvent = (data: { event: string; appUrn: string; error?: string }) => {
    const { event, appUrn, error } = data;
    if (error) console.error(error);

    let appName = appUrn;
    try {
      appName = extractAppUrn(appUrn).appName;
    } catch { /* ignore */ }

    const messages: Record<string, string> = {
      install_success: `${appName} installed successfully`,
      install_error: `${appName} failed to install`,
      start_success: `${appName} started`,
      start_error: `${appName} failed to start`,
      stop_success: `${appName} stopped`,
      stop_error: `${appName} failed to stop`,
      uninstall_success: `${appName} uninstalled`,
      uninstall_error: `${appName} failed to uninstall`,
      update_success: `${appName} updated`,
      update_error: `${appName} failed to update`,
      restart_success: `${appName} restarted`,
      restart_error: `${appName} failed to restart`,
      backup_success: `${appName} backed up`,
      backup_error: `${appName} backup failed`,
      restore_success: `${appName} restored`,
      restore_error: `${appName} restore failed`,
      reset_success: `${appName} reset`,
      reset_error: `${appName} failed to reset`,
    };

    const msg = messages[event];
    if (msg) {
      if (event.endsWith('_error')) {
        toast.error(msg);
      } else {
        toast.success(msg);
      }
    }
  };

  initializeSSE();

  const handleFocus = () => {
    if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
      initializeSSE();
    }
  };
  window.addEventListener('focus', handleFocus);

  onCleanup(() => {
    window.removeEventListener('focus', handleFocus);
    eventSource?.close();
  });

  return <>{props.children}</>;
};
