import crypto from 'node:crypto';
import type { AppUrn } from '@ci-hub/common/types';
import { CacheService } from '@/core/cache/cache.service';
import { Injectable } from '@nestjs/common';

/** Hub session lifetime in seconds (stored in SQLite cache). */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

/** Clients should rotate sessions after this many seconds to stay ahead of expiry. */
export const SESSION_REFRESH_AFTER_SECONDS = 60 * 60 * 24 * 5;

/** Old session IDs stay valid briefly after rotation so in-flight requests can finish. */
export const SESSION_ROTATION_GRACE_SECONDS = 60;

/**
 * Every Hub-session key starts with this. The session store shares the SQLite cache
 * table, so `AppService` spares this prefix from the version-bump wipe (#944) — exported
 * so that stays true if the key shape ever changes here.
 */
export const SESSION_KEY_PREFIX = 'session:';

/**
 * ⚠ APP SESSIONS ARE KEYED OUTSIDE `session:`. `resolveSessionUserId` — and so
 * `AuthMiddleware` — only ever reads under `SESSION_KEY_PREFIX`, so an app-session id is
 * never a Hub credential, whichever cookie, header, or query parameter it arrives in.
 * Spared from the version-bump wipe alongside it.
 */
export const APP_SESSION_KEY_PREFIX = 'app_session:';

/** Rotation-grace aliases share the session namespace but are keyed by session id alone. */
const GRACE_KEY_PREFIX = `${SESSION_KEY_PREFIX}grace:`;

const sessionKey = (sessionId: string) => `${SESSION_KEY_PREFIX}${sessionId}`;
const sessionGraceKey = (sessionId: string) => `${GRACE_KEY_PREFIX}${sessionId}`;
const userSessionKey = (userId: number, sessionId: string) => `${SESSION_KEY_PREFIX}${userId}:${sessionId}`;
const appSessionKey = (appSessionId: string) => `${APP_SESSION_KEY_PREFIX}${appSessionId}`;

/**
 * Ids are spliced into keys verbatim, and every real one is a `crypto.randomUUID()`, which never
 * contains `:`. An id that does addresses another key under `session:`: `grace:<id>` names that
 * session's rotation-grace alias, and touching it would re-arm the 60-second alias for a full TTL,
 * so neither rotation nor logout would end the session.
 */
const isSessionIdShaped = (sessionId: unknown): sessionId is string =>
  typeof sessionId === 'string' && sessionId.length > 0 && !sessionId.includes(':');

/** An app session is extended to its parent's expiry once the parent has been extended at least this far past it. */
const APP_SESSION_FOLLOW_PARENT_MS = 60 * 60 * 1000;

/**
 * What an edge-SSO consume leaves on an app host instead of the Hub's own session: forward-auth
 * identity for one app, derived from a live Hub session and never outliving it.
 */
export interface AppSession {
  userId: number;
  parentSessionId: string;
  appUrn: AppUrn;
}

@Injectable()
export class SessionManager {
  constructor(private cache: CacheService) {}

  /**
   * Create a new session for the given user.
   * @param userId - The ID of the user to create a session for.
   * @returns The session ID.
   */
  public async createSession(userId: number) {
    const sessionId = crypto.randomUUID();
    const key = sessionKey(sessionId);

    this.cache.set(key, userId.toString(), SESSION_TTL_SECONDS);
    this.cache.set(userSessionKey(userId, sessionId), key, SESSION_TTL_SECONDS);

    return sessionId;
  }

  public generateSalt() {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Delete a session by its ID.
   * @param sessionId - The ID of the session to delete.
   */
  public async deleteSession(sessionId: string) {
    const key = sessionKey(sessionId);
    const userId = this.cache.get(key);

    this.cache.del(key);
    if (userId) {
      this.cache.del(userSessionKey(Number(userId), sessionId));
    }
  }

  /** Resolve a session or rotation-grace session to its user ID. */
  public resolveSessionUserId(sessionId: string): number | null {
    if (!isSessionIdShaped(sessionId)) {
      return null;
    }

    const userId = this.cache.get(sessionKey(sessionId)) ?? this.cache.get(sessionGraceKey(sessionId));
    if (!userId || Number.isNaN(Number(userId))) {
      return null;
    }

    return Number(userId);
  }

  /** Extend a valid session to the full TTL window. */
  public touchSession(sessionId: string): boolean {
    if (!isSessionIdShaped(sessionId)) {
      return false;
    }

    const userId = this.cache.get(sessionKey(sessionId));
    if (!userId) {
      return false;
    }

    const key = sessionKey(sessionId);
    this.cache.set(key, userId, SESSION_TTL_SECONDS);
    this.cache.set(userSessionKey(Number(userId), sessionId), key, SESSION_TTL_SECONDS);
    return true;
  }

  /** Absolute expiry timestamp (ms) for a live session, or null when missing. */
  public getSessionExpiresAt(sessionId: string): number | null {
    return isSessionIdShaped(sessionId) ? this.cache.getExpirationAt(sessionKey(sessionId)) : null;
  }

  /**
   * Replace a valid session with a new ID and a fresh TTL for the same user.
   * Returns null when the current session is missing or expired.
   */
  public async rotateSession(sessionId: string): Promise<string | null> {
    if (!isSessionIdShaped(sessionId)) {
      return null;
    }

    const key = sessionKey(sessionId);
    const userId = this.cache.get(key);
    if (!userId || Number.isNaN(Number(userId))) {
      return null;
    }

    this.cache.set(sessionGraceKey(sessionId), userId, SESSION_ROTATION_GRACE_SECONDS);
    await this.deleteSession(sessionId);
    return this.createSession(Number(userId));
  }

  /**
   * Given a user ID, destroy all sessions for that user
   *
   * @param {number} userId - The user ID
   */
  public destroyAllSessionsByUserId = async (userId: number) => {
    for (const session of this.cache.getByPrefix(`${SESSION_KEY_PREFIX}${userId}:`)) {
      this.cache.del(session.key);
      if (session.val) this.cache.del(session.val);
    }

    // Rotation-grace aliases need their own sweep. `rotateSession` drops the per-user
    // index entry when it rotates, so a just-rotated session is unreachable from the
    // loop above — while `resolveSessionUserId` still honours its alias, and that is
    // what `AuthMiddleware` authenticates on. Without this, a session rotated in the
    // last 60 seconds stayed usable for the rest of that window after a "sign out
    // everywhere" (password or username change, operator reset). The alias stores its
    // owning user id as the value, which is what makes an ownership sweep possible.
    const owner = String(userId);
    for (const grace of this.cache.getByPrefix(GRACE_KEY_PREFIX)) {
      if (grace.val === owner) {
        this.cache.del(grace.key);
      }
    }
  };

  /**
   * Create a session that authenticates `userId` to ONE app, derived from their Hub session
   * `parentSessionId`. Null when that session no longer resolves to `userId`.
   *
   * The TTL is capped at what the parent has left, so the record never outlasts it, and
   * `resolveAppSession` refuses it as soon as the parent stops resolving — which is how logout,
   * rotation, and sign-out-everywhere reach app sessions without a sweep of their own.
   */
  public async createAppSession(userId: number, parentSessionId: string, appUrn: AppUrn): Promise<string | null> {
    // A rotation-grace parent still resolves, so its (short) remaining life counts too.
    const parentExpiresAt = this.cache.getExpirationAt(sessionKey(parentSessionId)) ?? this.cache.getExpirationAt(sessionGraceKey(parentSessionId));
    const ttlSeconds = parentExpiresAt ? Math.min(SESSION_TTL_SECONDS, Math.floor((parentExpiresAt - Date.now()) / 1000)) : 0;
    if (ttlSeconds <= 0 || this.resolveSessionUserId(parentSessionId) !== userId) {
      return null;
    }

    const appSessionId = crypto.randomUUID();
    const record: AppSession = { userId, parentSessionId, appUrn };
    this.cache.set(appSessionKey(appSessionId), JSON.stringify(record), ttlSeconds);
    return appSessionId;
  }

  /**
   * Resolve an app session, or null — honoured only while its parent still resolves to the same user.
   *
   * A refused record is deleted, because its parent never resolves again. A live one follows its
   * parent: once the parent has been extended past it, it is extended to the parent's expiry, never
   * beyond, so an app tab stays signed in for as long as the Hub session it was derived from.
   */
  public resolveAppSession(appSessionId: string): AppSession | null {
    const key = appSessionKey(appSessionId);
    const raw = this.cache.get(key);
    if (!raw) {
      return null;
    }

    let record: Partial<AppSession> | null = null;
    try {
      record = JSON.parse(raw) as Partial<AppSession> | null;
    } catch {
      // Unreadable, so refused below.
    }

    const { userId, parentSessionId, appUrn } = record ?? {};
    if (typeof userId !== 'number' || typeof parentSessionId !== 'string' || !parentSessionId || typeof appUrn !== 'string' || !appUrn) {
      this.cache.del(key);
      return null;
    }

    if (this.resolveSessionUserId(parentSessionId) !== userId) {
      this.cache.del(key);
      return null;
    }

    this.followParentExpiry(key, raw, parentSessionId);
    return { userId, parentSessionId, appUrn };
  }

  /** Extend an app session to its parent's expiry once the parent has been extended well past it. */
  private followParentExpiry(key: string, raw: string, parentSessionId: string) {
    // Only the live session key counts: a rotation-grace alias is on its way out and extends nothing.
    const parentExpiresAt = this.cache.getExpirationAt(sessionKey(parentSessionId));
    const expiresAt = this.cache.getExpirationAt(key);
    if (!parentExpiresAt || !expiresAt || parentExpiresAt - expiresAt < APP_SESSION_FOLLOW_PARENT_MS) {
      return;
    }

    const ttlSeconds = Math.min(SESSION_TTL_SECONDS, Math.floor((parentExpiresAt - Date.now()) / 1000));
    if (ttlSeconds > 0) {
      this.cache.set(key, raw, ttlSeconds);
    }
  }
}
