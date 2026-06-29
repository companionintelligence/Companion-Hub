/**
 * App Intents bridge (iOS Siri / Shortcuts / Spotlight / Action Button).
 *
 * The native Swift `AppIntent`s (see
 * `packages/mobile/src-tauri/gen/apple/Sources/AppIntents/`) don't navigate the
 * app themselves — they open a `cihub://intent/<action>` deep link. The Rust
 * shell captures it and emits a `deep-link-intent` event (or stashes it for
 * `consume_pending_intent` on a cold start). This module turns that action
 * string into a concrete navigation, reusing the existing mobile-connection
 * plumbing.
 *
 * The "open a specific Hub by name" intent passes a free-form name; we resolve
 * it here against the user's known Hubs (persisted when the picker loads them),
 * so all of the matching logic is testable JS rather than native code.
 *
 * Everything is inert off mobile (`isTauriMobileSync()` stays false).
 */
import { clearHubConnection, getHubBaseUrlSync, isTauriMobileSync, setHubConnection } from '@/lib/mobile-connection';

const STORE_FILE = 'app-intents.json';
const KNOWN_HUBS_KEY = 'knownHubs';

export type IntentAction = { kind: 'home' } | { kind: 'connect' } | { kind: 'switch' } | { kind: 'settings' } | { kind: 'open'; hub: string };

export interface KnownHub {
  id: string;
  name: string;
  hubUrl: string | null;
}

/** Where an intent should take the app. `reload` forces a full document load
 * (used when the active Hub base URL changes, so the API client re-initialises). */
export interface IntentNavigation {
  path: string;
  reload: boolean;
}

/**
 * Parse a captured action string (the part after `cihub://intent/`) into a
 * typed action. Examples: `home`, `connect`, `open?hub=Apple%20Hub`.
 * Returns null for anything unrecognised.
 */
export function parseIntentAction(raw: string | null | undefined): IntentAction | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const qIdx = trimmed.indexOf('?');
  const path = (qIdx === -1 ? trimmed : trimmed.slice(0, qIdx)).toLowerCase();
  const query = qIdx === -1 ? '' : trimmed.slice(qIdx + 1);

  switch (path) {
    case 'home':
    case 'open-hub':
      return { kind: 'home' };
    case 'connect':
      return { kind: 'connect' };
    case 'switch':
      return { kind: 'switch' };
    case 'settings':
      return { kind: 'settings' };
    case 'open': {
      const hub = (new URLSearchParams(query).get('hub') ?? '').trim();
      return { kind: 'open', hub };
    }
    default:
      return null;
  }
}

/** Case-insensitive match of a spoken/typed Hub name against the known Hubs:
 * exact match first, then a unique substring match. */
export function matchHubByName(hubs: KnownHub[], name: string): KnownHub | null {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  const exact = hubs.find((h) => h.name.trim().toLowerCase() === q);
  if (exact) return exact;
  const partial = hubs.filter((h) => h.name.trim().toLowerCase().includes(q));
  return partial.length === 1 ? (partial[0] ?? null) : null;
}

async function openStore() {
  const { load } = await import('@tauri-apps/plugin-store');
  return load(STORE_FILE);
}

/** Persist the user's Hubs so a later "open <name>" intent can resolve the name
 * even on a cold start. Mobile-only; best-effort. */
export async function publishHubsToIntents(hubs: KnownHub[]): Promise<void> {
  if (!isTauriMobileSync()) return;
  try {
    const store = await openStore();
    await store.set(
      KNOWN_HUBS_KEY,
      hubs.map((h) => ({ id: h.id, name: h.name, hubUrl: h.hubUrl })),
    );
    await store.save();
  } catch {
    // Best-effort — name resolution simply falls back to the connect screen.
  }
}

/** Read the persisted Hubs for intent name resolution. */
export async function loadKnownHubs(): Promise<KnownHub[]> {
  try {
    const store = await openStore();
    const hubs = await store.get<KnownHub[]>(KNOWN_HUBS_KEY);
    return Array.isArray(hubs) ? hubs : [];
  } catch {
    return [];
  }
}

/**
 * Resolve a typed action to a navigation target, performing any connection
 * side-effect (re-pointing at a different Hub) along the way.
 */
export async function resolveIntentNavigation(action: IntentAction, knownHubs: KnownHub[]): Promise<IntentNavigation> {
  switch (action.kind) {
    case 'home':
      return { path: '/', reload: false };
    case 'connect':
    case 'switch':
      // Re-pick a Hub. Clear the active connection first, otherwise the
      // `/connect` loader sees a chosen Hub and immediately redirects back to
      // `/`, making the intent a no-op. Reload so the API client re-inits.
      await clearHubConnection();
      return { path: '/connect', reload: true };
    case 'settings':
      return { path: '/settings', reload: false };
    case 'open': {
      const match = matchHubByName(knownHubs, action.hub);
      if (match?.hubUrl) {
        if (getHubBaseUrlSync() === match.hubUrl) {
          return { path: '/', reload: false };
        }
        // Different Hub → re-point the client and hard-reload so it re-inits.
        await setHubConnection(match.hubUrl);
        return { path: '/', reload: true };
      }
      // Unknown name → let the user pick.
      return { path: '/connect', reload: false };
    }
  }
}

/** Drain an intent captured by the Rust shell before the UI mounted (cold start
 * via Siri/Shortcuts). Returns the parsed action, or null. */
export async function takePendingIntent(): Promise<IntentAction | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return null;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const action = await invoke<string | null>('consume_pending_intent');
    return parseIntentAction(action);
  } catch {
    return null;
  }
}
