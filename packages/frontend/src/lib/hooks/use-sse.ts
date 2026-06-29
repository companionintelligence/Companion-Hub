import type { SSE, Topic } from '@ci-hub/common/schemas';
import { useEffect, useRef } from 'react';
import { client } from '@/api-client/client.gen';
import { getTauriSessionId } from '@/lib/api-fetch';
import { refreshHubSessionIfDue } from '@/lib/hub-session-refresh';

type Props<T> = {
  topic: T;
  onEvent: (event: Extract<SSE, { topic: T }>['data']) => void;
  onError?: (error: Event) => void;
  onOpen?: () => void;
  onReconnecting?: (attempt: number, delayMs: number) => void;
  params?: URLSearchParams;
};

export const MAX_SSE_RETRY_DELAY_MS = 60_000;

export function getSseRetryDelayMs(attempt: number): number {
  return Math.min(2 ** attempt * 1000, MAX_SSE_RETRY_DELAY_MS);
}

export const useSSE = <T extends Topic>(props: Props<T>) => {
  const { topic, onEvent, onError, onOpen, onReconnecting } = props;
  const eventSourceRef = useRef<EventSource | null>(null);
  const retries = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const reconnectAfterSessionRefresh = () => {
    if (!isMountedRef.current) {
      return;
    }

    void refreshHubSessionIfDue().finally(() => {
      if (!isMountedRef.current) {
        return;
      }
      initializeSSE();
    });
  };

  const initializeSSE = () => {
    if (!isMountedRef.current) {
      return;
    }

    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && !window.location.origin.startsWith('http://localhost:');
    const baseUrl = isTauri ? (client.getConfig().baseUrl ?? window.location.origin) : window.location.origin;
    const url = new URL(`${baseUrl}/api/sse/${topic}`);

    if (props.params) {
      url.search = props.params.toString();
    }

    // EventSource doesn't support custom headers, so pass session ID as query param for Tauri
    if (isTauri) {
      const sid = getTauriSessionId();
      if (sid) {
        url.searchParams.set('session_id', sid);
      }
    }

    const eventSource = new EventSource(url);

    eventSource.onmessage = (e) => {
      try {
        onEvent(JSON.parse(e.data));
      } catch (error) {
        console.error('Failed to parse SSE message:', error);
      }
    };

    eventSource.onopen = () => {
      retries.current = 0;
      console.info('SSE connection opened');
      if (onOpen) onOpen();
    };

    eventSource.onerror = (error) => {
      if (onError) {
        onError(error);
      } else {
        console.error('SSE connection error:', error);
      }

      eventSource.close();
      eventSourceRef.current = null;

      retries.current += 1;
      const delayMs = getSseRetryDelayMs(retries.current);
      onReconnecting?.(retries.current, delayMs);

      clearReconnectTimer();

      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        if (!isMountedRef.current) {
          return;
        }

        void refreshHubSessionIfDue().finally(() => {
          if (!isMountedRef.current) {
            return;
          }
          console.info(`Retrying SSE connection after error (attempt ${retries.current})`);
          initializeSSE();
        });
      }, delayMs);
    };

    eventSourceRef.current = eventSource;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: This hook should only run once on mount
  useEffect(() => {
    isMountedRef.current = true;

    const reconnectIfClosed = () => {
      if (!isMountedRef.current) {
        return;
      }

      if (!eventSourceRef.current || eventSourceRef.current.readyState === EventSource.CLOSED) {
        clearReconnectTimer();
        reconnectAfterSessionRefresh();
      }
    };

    // Only initialize if not already connected
    if (!eventSourceRef.current || eventSourceRef.current.readyState === EventSource.CLOSED) {
      initializeSSE();
    }

    window.addEventListener('focus', reconnectIfClosed);
    window.addEventListener('pageshow', reconnectIfClosed);
    window.addEventListener('online', reconnectIfClosed);

    return () => {
      isMountedRef.current = false;
      window.removeEventListener('focus', reconnectIfClosed);
      window.removeEventListener('pageshow', reconnectIfClosed);
      window.removeEventListener('online', reconnectIfClosed);
      clearReconnectTimer();
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);
};
