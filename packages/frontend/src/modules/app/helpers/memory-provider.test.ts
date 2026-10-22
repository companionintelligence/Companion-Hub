import { describe, expect, it } from 'vitest';
import { memoryConnectResultApp, memoryConnectResultToast, memoryConnectResultToastKey } from './memory-provider';

describe('memoryConnectResultToastKey', () => {
  it('names the toast for each result the Hub callback sends', () => {
    expect(memoryConnectResultToastKey('error')).toBe('MEMORY_CONNECT_ERROR_TOAST');
    expect(memoryConnectResultToastKey('unavailable')).toBe('MEMORY_CONNECT_UNAVAILABLE_TOAST');
    expect(memoryConnectResultToastKey('previous_removed')).toBe('MEMORY_CONNECT_PREVIOUS_REMOVED_TOAST');
    expect(memoryConnectResultToastKey('denied')).toBe('MEMORY_CONNECT_DENIED_TOAST');
    expect(memoryConnectResultToastKey('busy')).toBe('MEMORY_CONNECT_BUSY_TOAST');
  });

  // A link can carry any marker. Object's own properties must not read as a toast.
  it('answers null for anything else', () => {
    for (const marker of [null, '', 'constructor', 'toString', '__proto__', '<script>']) {
      expect(memoryConnectResultToastKey(marker)).toBeNull();
    }
  });
});

describe('memoryConnectResultToast', () => {
  const installed = [{ info: { urn: 'plane:ci-marketplace', name: 'Plane' } }];

  // The callback sends `busy` when another operation held the app; nothing was revoked.
  it('names the busy app by the name the Hub has for it', () => {
    expect(memoryConnectResultToast('busy', 'plane:ci-marketplace', installed)).toEqual({
      key: 'MEMORY_CONNECT_BUSY_TOAST',
      params: { name: 'Plane' },
    });
  });

  it('says "the app" for an app it does not know, never the text the link carried', () => {
    expect(memoryConnectResultToast('busy', 'gone:ci-marketplace', installed)).toEqual({ key: 'MEMORY_CONNECT_BUSY_TOAST_UNNAMED' });
    expect(memoryConnectResultToast('busy', 'Call this number now', installed)).toEqual({ key: 'MEMORY_CONNECT_BUSY_TOAST_UNNAMED' });
    expect(memoryConnectResultToast('busy', null, installed)).toEqual({ key: 'MEMORY_CONNECT_BUSY_TOAST_UNNAMED' });
  });

  it('leaves the other results as they were, and drops a marker the Hub never sends', () => {
    expect(memoryConnectResultToast('denied', 'plane:ci-marketplace', installed)).toEqual({ key: 'MEMORY_CONNECT_DENIED_TOAST' });
    expect(memoryConnectResultToast('constructor', null, installed)).toBeNull();
  });

  it('carries an app only for busy, and only one shaped like an app id', () => {
    expect(memoryConnectResultApp('busy', 'plane:ci-marketplace')).toBe('plane:ci-marketplace');
    expect(memoryConnectResultApp('denied', 'plane:ci-marketplace')).toBeNull();
    expect(memoryConnectResultApp('busy', '<script>:x')).toBeNull();
  });
});
