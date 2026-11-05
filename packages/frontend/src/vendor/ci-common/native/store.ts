// vendored-from: @companionintelligence/native@0.1.0 packages/native/src/store.ts
/**
 * The secure store holds the refresh token between launches. On iOS and Android it is
 * the Keychain or Keystore. On Tauri it is the `ci-auth` plugin's secure_* commands.
 *
 * There is no browser-storage default. localStorage is readable by any script on the
 * page, so a web build has no secure store and cannot persist a refresh token.
 */
import { SecureStoreError } from './errors.js';

/**
 * A platform's secure store. Every implementation must follow these rules.
 *
 * - `remove(key)` for a key that is not stored resolves without error and leaves the store
 *   unchanged. It is idempotent. A store that rejects a missing item would make `signOut`
 *   reject after the token is already gone.
 * - `signOut` may call `remove` more than once for the same key. On the normal path it calls
 *   it twice: once immediately, and once queued behind any refresh already in flight.
 */
export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * Tauri's invoke, typed loosely enough to accept the real one and test fakes.
 * `args` is passed through unchanged.
 */
export type InvokeFn = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface TauriSecureStoreOptions {
  readonly invoke: InvokeFn;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * In-memory store for tests and examples only. It loses everything when the process
 * exits, and it does not protect values at rest.
 */
export function createMemorySecureStore(): SecureStore {
  const values = new Map<string, string>();
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async remove(key) {
      values.delete(key);
    },
  };
}

/**
 * SecureStore backed by the Tauri `ci-auth` plugin. The command names are fixed by the
 * Rust plugin: `plugin:ci-auth|secure_get`, `secure_set` and `secure_remove`.
 * `secure_get` must reply `{ value: string | null }`.
 */
export function createTauriSecureStore({ invoke }: TauriSecureStoreOptions): SecureStore {
  return {
    async get(key) {
      const reply = await invoke<unknown>('plugin:ci-auth|secure_get', { key });
      const value = isRecord(reply) ? reply.value : undefined;
      if (value === null) return null;
      if (typeof value !== 'string') {
        throw new SecureStoreError('secure_get did not reply with { value: string | null }');
      }
      return value;
    },
    async set(key, value) {
      await invoke('plugin:ci-auth|secure_set', { key, value });
    },
    async remove(key) {
      await invoke('plugin:ci-auth|secure_remove', { key });
    },
  };
}
