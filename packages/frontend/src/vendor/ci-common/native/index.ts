// vendored-from: @companionintelligence/native@0.1.0 packages/native/src/index.ts
/**
 * @companionintelligence/native: the framework-free native sign-in runtime.
 *
 * Shell detection, the secure-store and sign-in driver contracts, the Capacitor and
 * Tauri drivers, and runSignIn / refreshSession / signOut on top of
 * @companionintelligence/auth. Identity-contract errors (StateMismatchError,
 * TokenRequestError and the rest) come from the auth package unchanged.
 */

export { detectShell, type ShellGlobal, type ShellInfo, type ShellKind, type ShellPlatform } from './shell.js';

export {
  createMemorySecureStore,
  createTauriSecureStore,
  type InvokeFn,
  type SecureStore,
  type TauriSecureStoreOptions,
} from './store.js';

export {
  createCapacitorSignInDriver,
  createTauriSignInDriver,
  type CapacitorAuthPlugin,
  type CapacitorSignInDriverOptions,
  type OpenUrl,
  type SignInDriver,
  type SignInRedirect,
  type SignInStartRequest,
  type TauriSignInDriverOptions,
} from './driver.js';

export {
  refreshSession,
  refreshTokenKey,
  runSignIn,
  signOut,
  type NativeAuthConfig,
  type NativeEndpoints,
  type RefreshSessionOptions,
  type RunSignInOptions,
  type SignedInSession,
  type SignOutOptions,
} from './sign-in.js';

export { SecureStoreError, SignedOutError, SignInCancelledError, SignInError } from './errors.js';
