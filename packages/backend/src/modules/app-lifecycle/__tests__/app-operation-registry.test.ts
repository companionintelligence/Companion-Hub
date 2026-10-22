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

  it('claimCompletion() succeeds only for the latest requestId and clears the entry', () => {
    registry.register(APP, { requestId: REQ, command: 'restart', tier: 'safe' });
    expect(registry.claimCompletion(APP, 'stale')).toBe(false);
    expect(registry.get(APP)).toBeDefined();
    expect(registry.claimCompletion(APP, REQ)).toBe(true);
    expect(registry.get(APP)).toBeUndefined();
  });

  it('ownsOutcome() reflects whether the requestId is still current', () => {
    registry.register(APP, { requestId: REQ, command: 'start', tier: 'safe' });
    expect(registry.ownsOutcome(APP, REQ)).toBe(true);
    registry.register(APP, { requestId: 'newer', command: 'restart', tier: 'safe' });
    expect(registry.ownsOutcome(APP, REQ)).toBe(false);
    expect(registry.ownsOutcome(APP, 'newer')).toBe(true);
  });

  // #2101: every command claims the app before it reads or writes its row, and a second one is refused.
  describe('claims', () => {
    it('claims a free app, and names the claim to a second caller', () => {
      const first = registry.claim(APP, 'uninstall');
      const second = registry.claim(APP, 'start');

      expect(first.claimed).toBe(true);
      expect(second).toEqual({ claimed: false, busy: { command: 'uninstall', stage: 'claimed' } });
    });

    it('names a dispatched command to a caller', () => {
      registry.register(APP, { requestId: REQ, command: 'update', tier: 'before_ponr' });

      expect(registry.claim(APP, 'install')).toEqual({ claimed: false, busy: { command: 'update', stage: 'dispatched' } });
    });

    it('lets register take the claim over, so handing it back afterwards changes nothing', () => {
      const claim = registry.claim(APP, 'start');
      registry.register(APP, { requestId: REQ, command: 'start', tier: 'safe' });
      if (claim.claimed) {
        registry.releaseClaim(APP, claim.token);
      }

      expect(registry.liveOperation(APP)).toEqual({ command: 'start', stage: 'dispatched' });
    });

    it('frees the app when a claim is handed back before anything was dispatched', () => {
      const claim = registry.claim(APP, 'reset');
      if (claim.claimed) {
        registry.releaseClaim(APP, claim.token);
      }

      expect(registry.liveOperation(APP)).toBeUndefined();
      expect(registry.claim(APP, 'start').claimed).toBe(true);
    });

    it('does not let an old claim hand back a newer one', () => {
      const old = registry.claim(APP, 'start');
      registry.register(APP, { requestId: REQ, command: 'start', tier: 'safe' });
      registry.claimCompletion(APP, REQ);
      registry.claim(APP, 'stop');
      if (old.claimed) {
        registry.releaseClaim(APP, old.token);
      }

      expect(registry.liveOperation(APP)).toEqual({ command: 'stop', stage: 'claimed' });
    });

    it('stops counting an operation older than the queue waits for a command', () => {
      registry.register(APP, { requestId: REQ, command: 'stop', tier: 'safe' });
      const now = Date.now();

      expect(registry.liveOperation(APP, now + 44 * 60 * 1000)).toBeDefined();
      expect(registry.liveOperation(APP, now + 46 * 60 * 1000)).toBeUndefined();
      expect(registry.claim(APP, 'start', now + 46 * 60 * 1000).claimed).toBe(true);
    });

    it('keeps an install call apart from the operations it checks against', () => {
      registry.beginInstallCall(APP);

      expect(registry.isInstallCallUnderWay(APP)).toBe(true);
      expect(registry.liveOperation(APP)).toBeUndefined();
    });
  });

  describe('waiting for an app and settling an outcome', () => {
    it('wakes a waiter when the operation holding the app settles', async () => {
      registry.register(APP, { requestId: REQ, command: 'start', tier: 'safe' });
      let woken = false;
      const waiting = registry.whenMaybeFree(APP, 60_000).then(() => {
        woken = true;
      });

      await Promise.resolve();
      expect(woken).toBe(false);
      registry.claimCompletion(APP, REQ);
      await waiting;

      expect(woken).toBe(true);
    });

    it('wakes a waiter after its timeout when nothing frees the app', async () => {
      registry.register(APP, { requestId: REQ, command: 'start', tier: 'safe' });

      await expect(registry.whenMaybeFree(APP, 10)).resolves.toBeUndefined();
      expect(registry.liveOperation(APP)).toBeDefined();
    });

    it('keeps the app claimed while a settled outcome is written, and frees it once handed back', () => {
      registry.register(APP, { requestId: REQ, command: 'start', tier: 'safe' });

      const settling = registry.settleCompletion(APP, REQ);

      expect(registry.get(APP)).toBeUndefined();
      expect(registry.claim(APP, 'restart')).toEqual({ claimed: false, busy: { command: 'start', stage: 'claimed' } });
      registry.releaseClaim(APP, settling as symbol);
      expect(registry.claim(APP, 'restart').claimed).toBe(true);
    });

    it('settles nothing for a superseded request', () => {
      registry.register(APP, { requestId: 'newer', command: 'stop', tier: 'safe' });

      expect(registry.settleCompletion(APP, REQ)).toBeNull();
      expect(registry.get(APP)?.requestId).toBe('newer');
    });

    // A force stop registers over a hung stop, but must not wipe another caller's pending claim.
    it("keeps another caller's claim when a register does not take it over", () => {
      registry.claim(APP, 'restart');
      registry.register(APP, { requestId: 'force', command: 'stop', tier: 'safe' }, { takesOverClaim: false });
      registry.claimCompletion(APP, 'force');

      expect(registry.liveOperation(APP)).toEqual({ command: 'restart', stage: 'claimed' });
    });
  });

  describe('a cancel sent while an install checks the grant', () => {
    it('is held for the install and handed to it once, when its check ends', () => {
      registry.beginInstallGrantCheck(APP);

      expect(registry.holdGrantCheckCancel(APP)).toBe(true);
      expect(registry.endInstallGrantCheck(APP)).toBe(true);
      expect(registry.holdGrantCheckCancel(APP)).toBe(false);
    });

    it('finds nothing to hold once no install is checking', () => {
      expect(registry.holdGrantCheckCancel(APP)).toBe(false);
      expect(registry.endInstallGrantCheck(APP)).toBe(false);
    });
  });
});
