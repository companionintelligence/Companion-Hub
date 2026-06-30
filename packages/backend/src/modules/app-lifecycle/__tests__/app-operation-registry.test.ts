import { describe, it, expect, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { AppOperationRegistry } from '../app-operation-registry';

const APP = 'myapp:ci-marketplace' as any;
const REQ = '00000000-0000-4000-8000-000000000001';

describe('AppOperationRegistry', () => {
  let registry: AppOperationRegistry;

  beforeEach(() => {
    registry = new AppOperationRegistry(mock<LoggerService>());
  });

  it('register() stores and get() returns the entry', () => {
    const entry = registry.register(APP, { requestId: REQ, command: 'install', tier: 'safe' });
    expect(entry.phase).toBe('queued');
    expect(entry.abortController.signal.aborted).toBe(false);
    expect(registry.get(APP)).toBe(entry);
    expect(registry.get(APP)?.requestId).toBe(REQ);
  });

  it('register() replaces an existing entry for the same app', () => {
    registry.register(APP, { requestId: REQ, command: 'install', tier: 'safe' });
    const second = registry.register(APP, { requestId: 'other', command: 'start', tier: 'safe' });
    expect(registry.get(APP)).toBe(second);
    expect(registry.get(APP)?.requestId).toBe('other');
  });

  it('markPhase() updates the phase, and is a no-op for unknown apps', () => {
    registry.register(APP, { requestId: REQ, command: 'install', tier: 'safe' });
    registry.markPhase(APP, 'pulling');
    expect(registry.get(APP)?.phase).toBe('pulling');
    expect(() => registry.markPhase('nope:store' as any, 'composing')).not.toThrow();
  });

  it('markPhase() with a mismatched requestId does not mutate a replacement op', () => {
    registry.register(APP, { requestId: REQ, command: 'install', tier: 'safe' });
    // A stale message (requestId 'old') must not change the phase of the current entry.
    registry.markPhase(APP, 'composing', 'old-request-id');
    expect(registry.get(APP)?.phase).toBe('queued');
    // The owning requestId still works.
    registry.markPhase(APP, 'composing', REQ);
    expect(registry.get(APP)?.phase).toBe('composing');
  });

  it('abort() aborts the controller and flags a queued op', () => {
    registry.register(APP, { requestId: REQ, command: 'install', tier: 'safe' });
    const aborted = registry.abort(APP);
    expect(aborted).toBeDefined();
    expect(registry.get(APP)?.abortController.signal.aborted).toBe(true);
    expect(registry.get(APP)?.cancelRequestedWhileQueued).toBe(true);
  });

  it('abort() does NOT flag cancelRequestedWhileQueued once running', () => {
    registry.register(APP, { requestId: REQ, command: 'install', tier: 'safe' });
    registry.markPhase(APP, 'pulling');
    registry.abort(APP);
    expect(registry.get(APP)?.abortController.signal.aborted).toBe(true);
    expect(registry.get(APP)?.cancelRequestedWhileQueued).toBe(false);
  });

  it('abort() with a mismatched requestId does nothing', () => {
    registry.register(APP, { requestId: REQ, command: 'install', tier: 'safe' });
    const result = registry.abort(APP, 'different');
    expect(result).toBeUndefined();
    expect(registry.get(APP)?.abortController.signal.aborted).toBe(false);
  });

  it('abort()/markPhase()/clear() on an empty registry are safe', () => {
    expect(registry.abort(APP)).toBeUndefined();
    expect(() => registry.markPhase(APP, 'pulling')).not.toThrow();
    expect(() => registry.clear(APP, REQ)).not.toThrow();
  });

  it('clear() removes the entry only when the requestId matches', () => {
    registry.register(APP, { requestId: REQ, command: 'install', tier: 'safe' });
    registry.clear(APP, 'wrong-id');
    expect(registry.get(APP)).toBeDefined(); // not removed — guards a replacement op
    registry.clear(APP, REQ);
    expect(registry.get(APP)).toBeUndefined();
  });
});
