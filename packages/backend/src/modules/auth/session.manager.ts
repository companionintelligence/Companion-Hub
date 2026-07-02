import crypto from 'node:crypto';
import { CacheService } from '@/core/cache/cache.service';
import { Injectable } from '@nestjs/common';

/** Hub session lifetime in seconds (stored in SQLite cache). */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

/** Clients should rotate sessions after this many seconds to stay ahead of expiry. */
export const SESSION_REFRESH_AFTER_SECONDS = 60 * 60 * 24 * 5;

/** Old session IDs stay valid briefly after rotation so in-flight requests can finish. */
export const SESSION_ROTATION_GRACE_SECONDS = 60;

const sessionKey = (sessionId: string) => `session:${sessionId}`;
const sessionGraceKey = (sessionId: string) => `session:grace:${sessionId}`;
const userSessionKey = (userId: number, sessionId: string) => `session:${userId}:${sessionId}`;

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
    const userId = this.cache.get(sessionKey(sessionId)) ?? this.cache.get(sessionGraceKey(sessionId));
    if (!userId || Number.isNaN(Number(userId))) {
      return null;
    }

    return Number(userId);
  }

  /** Extend a valid session to the full TTL window. */
  public touchSession(sessionId: string): boolean {
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
    return this.cache.getExpirationAt(sessionKey(sessionId));
  }

  /**
   * Replace a valid session with a new ID and a fresh TTL for the same user.
   * Returns null when the current session is missing or expired.
   */
  public async rotateSession(sessionId: string): Promise<string | null> {
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
    const sessions = await this.cache.getByPrefix(`session:${userId}:`);

    await Promise.all(
      sessions.map(async (session) => {
        this.cache.del(session.key);
        if (session.val) this.cache.del(session.val);
      }),
    );
  };
}
