import { describe, expect, it } from 'vitest';
import { memoryConnectResultToastKey } from './memory-provider';

describe('memoryConnectResultToastKey', () => {
  it('names the toast for each result the Hub callback sends', () => {
    expect(memoryConnectResultToastKey('error')).toBe('MEMORY_CONNECT_ERROR_TOAST');
    expect(memoryConnectResultToastKey('unavailable')).toBe('MEMORY_CONNECT_UNAVAILABLE_TOAST');
    expect(memoryConnectResultToastKey('previous_removed')).toBe('MEMORY_CONNECT_PREVIOUS_REMOVED_TOAST');
  });

  // A link can carry any marker. Object's own properties must not read as a toast.
  it('answers null for anything else', () => {
    for (const marker of [null, '', 'constructor', 'toString', '__proto__', '<script>']) {
      expect(memoryConnectResultToastKey(marker)).toBeNull();
    }
  });
});
