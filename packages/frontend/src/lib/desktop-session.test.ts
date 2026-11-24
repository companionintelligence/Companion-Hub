import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopSecureStore, removeDesktopSession, writeDesktopSessionId } from './desktop-session';

type TauriWindow = { __TAURI_INTERNALS__?: { invoke: typeof invoke } };
const tauriWindow = window as unknown as TauriWindow;

/** A fake Tauri IPC. Every secure_* command resolves, and the calls are recorded. */
const invoke = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined);

function installFakeIpc(): void {
  tauriWindow.__TAURI_INTERNALS__ = { invoke };
}

function keychain() {
  const store = desktopSecureStore();
  if (!store) {
    throw new Error('expected a keychain store once the Tauri IPC is installed');
  }
  return store;
}

beforeEach(() => {
  invoke.mockClear();
});

afterEach(() => {
  delete tauriWindow.__TAURI_INTERNALS__;
});

describe('desktopSecureStore', () => {
  it('has no keychain in a plain browser, so the session stays in memory only', () => {
    expect(desktopSecureStore()).toBeNull();
  });
});

describe('desktop session keychain entries', () => {
  it('writes the Hub session id to the keychain under ci.hub.session', async () => {
    installFakeIpc();

    await writeDesktopSessionId(keychain(), 'hub-session-1');

    expect(invoke).toHaveBeenCalledWith('plugin:ci-auth|secure_set', { key: 'ci.hub.session', value: 'hub-session-1' });
  });

  it('removes the Hub session id and the Portal refresh token on sign-out', async () => {
    installFakeIpc();

    await removeDesktopSession(keychain());

    expect(invoke).toHaveBeenCalledWith('plugin:ci-auth|secure_remove', { key: 'ci.hub.session' });
    expect(invoke).toHaveBeenCalledWith('plugin:ci-auth|secure_remove', { key: 'ci.auth.ci-hub.refresh' });
  });
});
