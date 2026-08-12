import type { SSE, Topic } from '@ci-hub/common/schemas';
import { useEffect, useRef } from 'react';
import { client } from '@/api-client/client.gen';
import { getTauriSessionId } from '@/lib/api-fetch';
import { refreshHubSessionIfDue } from '@/lib/hub-session-refresh';
import { mayHoldCookielessSession, usesCrossOriginDesktopApi } from '@/lib/hub-runtime-mode';

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

/**
 * Build the stream URL, carrying the session id in the query string when one is
 * supplied.
 *
 * EventSource cannot send the `X-CI-Hub-Session` header that `apiFetch` sets, so
 * the query param is its only way to present a session. Passing `null` keeps the
 * URL clean — see {@link mayHoldCookielessSession} for who gets an id at all.
 */
export function buildSseUrl(baseUrl: string, topic: string, sessionId: string | null, params?: URLSearchParams): URL {
  const url = new URL(`${baseUrl}/api/sse/${topic}`);

  if (params) {
    url.search = params.toString();
  }

  if (sessionId) {
    url.searchParams.set('session_id', sessionId);
  }

  return url;
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

    const crossOrigin = usesCrossOriginDesktopApi();
    const baseUrl = crossOrigin ? (client.getConfig().baseUrl ?? window.location.origin) : window.location.origin;
    // The desktop portal SSO handoff returns its session in the response body and
    // plants no cookie, so a same-origin desktop authenticates every REST call via
    // the header while the cookie-only EventSource 401s forever — no app events, and
    // install spinners that only resolve on the refetch a route change triggers.
    // Gated rather than unconditional: a browser already holds the cookie, so sending
    // the id would put a live credential in a URL to no end.
    const url = buildSseUrl(baseUrl, topic, mayHoldCookielessSession() ? getTauriSessionId() : null, props.params);

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
