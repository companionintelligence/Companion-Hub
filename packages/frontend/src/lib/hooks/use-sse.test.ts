import { describe, expect, it } from 'vitest';
import { MAX_SSE_RETRY_DELAY_MS, buildSseUrl, getSseRetryDelayMs } from './use-sse';

describe('getSseRetryDelayMs', () => {
  it('uses exponential backoff capped at one minute', () => {
    expect(getSseRetryDelayMs(1)).toBe(2_000);
    expect(getSseRetryDelayMs(2)).toBe(4_000);
    expect(getSseRetryDelayMs(5)).toBe(32_000);
    expect(getSseRetryDelayMs(6)).toBe(MAX_SSE_RETRY_DELAY_MS);
    expect(getSseRetryDelayMs(10)).toBe(MAX_SSE_RETRY_DELAY_MS);
  });
});

describe('buildSseUrl', () => {
  it('carries the session id on a same-origin URL', () => {
    // The regression: a desktop portal SSO login holds a session id but no cookie,
    // and EventSource cannot send the header apiFetch uses. Gating the param on
    // cross-origin left this stream permanently 401 — no app events reached the UI,
    // so install spinners never resolved.
    const url = buildSseUrl('http://127.0.0.1:5002', 'app', 'sess-local');

    expect(url.origin).toBe('http://127.0.0.1:5002');
    expect(url.pathname).toBe('/api/sse/app');
    expect(url.searchParams.get('session_id')).toBe('sess-local');
  });

  it('carries the session id on a cross-origin URL', () => {
    const url = buildSseUrl('https://hub.example.com', 'app', 'sess-remote');

    expect(url.searchParams.get('session_id')).toBe('sess-remote');
  });

  it('adds no param when the client holds no session id', () => {
    // A browser login authenticates by cookie and stores nothing, so the URL must
    // stay clean rather than gain an empty `session_id`.
    const url = buildSseUrl('http://127.0.0.1:5002', 'app', null);

    expect(url.searchParams.has('session_id')).toBe(false);
    expect(url.search).toBe('');
  });

  it('keeps caller params alongside the session id', () => {
    const url = buildSseUrl('http://127.0.0.1:5002', 'app-logs', 'sess-local', new URLSearchParams({ appUrn: 'ci-memory:ci-marketplace', maxLines: '300' }));

    expect(url.searchParams.get('appUrn')).toBe('ci-memory:ci-marketplace');
    expect(url.searchParams.get('maxLines')).toBe('300');
    expect(url.searchParams.get('session_id')).toBe('sess-local');
  });
});
