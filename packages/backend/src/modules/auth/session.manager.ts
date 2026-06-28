import crypto from 'node:crypto';
import { CacheService } from '@/core/cache/cache.service';
import { Injectable } from '@nestjs/common';

/** Hub session lifetime in seconds (stored in SQLite cache). */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

/** Clients should rotate sessions after this many seconds to stay ahead of expiry. */
export const SESSION_REFRESH_AFTER_SECONDS = 60 * 60 * 24 * 5;

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
    const sessionKey = `session:${sessionId}`;

    this.cache.set(sessionKey, userId.toString(), SESSION_TTL_SECONDS);
    this.cache.set(`session:${userId}:${sessionId}`, sessionKey, SESSION_TTL_SECONDS);

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
    const sessionKey = `session:${sessionId}`;
    const userId = this.cache.get(sessionKey);

    this.cache.del(sessionKey);
    if (userId) {
      this.cache.del(`session:${userId}:${sessionId}`);
    }
  }

  /**
   * Replace a valid session with a new ID and a fresh TTL for the same user.
   * Returns null when the current session is missing or expired.
   */
  public async rotateSession(sessionId: string): Promise<string | null> {
    const sessionKey = `session:${sessionId}`;
    const userId = this.cache.get(sessionKey);
    if (!userId || Number.isNaN(Number(userId))) {
      return null;
    }

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
