import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type Database from 'better-sqlite3';

export interface User {
  id: number;
  email: string;
  password_hash: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  email_verified: number;
  stripe_customer_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateUserParams {
  email: string;
  password: string;
  username?: string;
  display_name?: string;
}

export interface UpdateUserParams {
  username?: string;
  display_name?: string;
  avatar_url?: string;
  email_verified?: boolean;
  stripe_customer_id?: string;
}

/**
 * Account Service
 * Manages user accounts for the payment service
 * This is the source of truth for user authentication in the payment ecosystem
 */
export class AccountService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Hash a password using SHA-256 with salt
   * In production, consider using bcrypt or argon2
   */
  private hashPassword(password: string, salt?: string): { hash: string; salt: string } {
    const useSalt = salt || randomBytes(16).toString('hex');
    const hash = createHash('sha256')
      .update(password + useSalt)
      .digest('hex');
    return { hash: `${useSalt}:${hash}`, salt: useSalt };
  }

  /**
   * Verify a password against a stored hash
   */
  private verifyPassword(password: string, storedHash: string): boolean {
    const [salt, hash] = storedHash.split(':');
    if (!salt || !hash) return false;
    
    const { hash: computedHash } = this.hashPassword(password, salt);
    const [, computedHashValue] = computedHash.split(':');
    
    try {
      return timingSafeEqual(
        Buffer.from(hash, 'hex'),
        Buffer.from(computedHashValue, 'hex')
      );
    } catch {
      return false;
    }
  }

  /**
   * Create a new user account
   */
  async createUser(params: CreateUserParams): Promise<User> {
    const { email, password, username, display_name } = params;

    // Check if email already exists
    const existing = this.db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      throw new Error('Email already registered');
    }

    // Check if username already exists (if provided)
    if (username) {
      const existingUsername = this.db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (existingUsername) {
        throw new Error('Username already taken');
      }
    }

    const { hash } = this.hashPassword(password);

    const stmt = this.db.prepare(`
      INSERT INTO users (email, password_hash, username, display_name)
      VALUES (?, ?, ?, ?)
    `);

    const result = stmt.run(email, hash, username || null, display_name || null);
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid) as User;

    return user;
  }

  /**
   * Authenticate a user with email and password
   */
  async authenticateUser(email: string, password: string): Promise<User | null> {
    const user = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as User | undefined;
    
    if (!user) {
      return null;
    }

    if (!this.verifyPassword(password, user.password_hash)) {
      return null;
    }

    return user;
  }

  /**
   * Get user by ID
   */
  async getUserById(id: number): Promise<User | null> {
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
    return user || null;
  }

  /**
   * Get user by email
   */
  async getUserByEmail(email: string): Promise<User | null> {
    const user = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as User | undefined;
    return user || null;
  }

  /**
   * Get user by username
   */
  async getUserByUsername(username: string): Promise<User | null> {
    const user = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
    return user || null;
  }

  /**
   * Update user profile
   */
  async updateUser(userId: number, params: UpdateUserParams): Promise<User | null> {
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (params.username !== undefined) {
      // Check if username is taken by another user
      if (params.username) {
        const existing = this.db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(params.username, userId);
        if (existing) {
          throw new Error('Username already taken');
        }
      }
      updates.push('username = ?');
      values.push(params.username || null);
    }

    if (params.display_name !== undefined) {
      updates.push('display_name = ?');
      values.push(params.display_name || null);
    }

    if (params.avatar_url !== undefined) {
      updates.push('avatar_url = ?');
      values.push(params.avatar_url || null);
    }

    if (params.email_verified !== undefined) {
      updates.push('email_verified = ?');
      values.push(params.email_verified ? 1 : 0);
    }

    if (params.stripe_customer_id !== undefined) {
      updates.push('stripe_customer_id = ?');
      values.push(params.stripe_customer_id || null);
    }

    if (updates.length === 0) {
      return this.getUserById(userId);
    }

    updates.push("updated_at = datetime('now')");
    values.push(userId);

    this.db.prepare(`
      UPDATE users SET ${updates.join(', ')} WHERE id = ?
    `).run(...values);

    return this.getUserById(userId);
  }

  /**
   * Change user password
   */
  async changePassword(userId: number, currentPassword: string, newPassword: string): Promise<boolean> {
    const user = await this.getUserById(userId);
    if (!user) {
      return false;
    }

    if (!this.verifyPassword(currentPassword, user.password_hash)) {
      return false;
    }

    const { hash } = this.hashPassword(newPassword);

    this.db.prepare(`
      UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?
    `).run(hash, userId);

    return true;
  }

  /**
   * Reset password (admin or recovery flow)
   */
  async resetPassword(userId: number, newPassword: string): Promise<boolean> {
    const { hash } = this.hashPassword(newPassword);

    const result = this.db.prepare(`
      UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?
    `).run(hash, userId);

    return result.changes > 0;
  }

  /**
   * Delete user account
   */
  async deleteUser(userId: number): Promise<boolean> {
    // Delete related data first
    this.db.prepare('DELETE FROM oauth_refresh_tokens WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM oauth_access_tokens WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM oauth_authorization_codes WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM app_entitlements WHERE user_id = ?').run(userId);
    
    const result = this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return result.changes > 0;
  }

  /**
   * Get user's app entitlements
   */
  async getUserEntitlements(userId: number): Promise<Array<{
    app_urn: string;
    entitlement_type: string;
    granted_at: string;
    expires_at: string | null;
  }>> {
    const entitlements = this.db.prepare(`
      SELECT app_urn, entitlement_type, granted_at, expires_at
      FROM app_entitlements
      WHERE user_id = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY granted_at DESC
    `).all(userId) as Array<{
      app_urn: string;
      entitlement_type: string;
      granted_at: string;
      expires_at: string | null;
    }>;

    return entitlements;
  }

  /**
   * Check if user has entitlement to an app
   */
  async hasEntitlement(userId: number, appUrn: string): Promise<boolean> {
    const entitlement = this.db.prepare(`
      SELECT id FROM app_entitlements
      WHERE user_id = ? AND app_urn = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      LIMIT 1
    `).get(userId, appUrn);

    return Boolean(entitlement);
  }

  /**
   * Grant entitlement to an app
   */
  async grantEntitlement(params: {
    userId: number;
    appUrn: string;
    entitlementType: 'purchase' | 'subscription' | 'free';
    paymentId?: number;
    subscriptionId?: number;
    expiresAt?: Date;
  }): Promise<void> {
    const { userId, appUrn, entitlementType, paymentId, subscriptionId, expiresAt } = params;

    // Use INSERT OR REPLACE to handle existing entitlements
    this.db.prepare(`
      INSERT OR REPLACE INTO app_entitlements 
      (user_id, app_urn, entitlement_type, payment_id, subscription_id, expires_at, granted_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      userId,
      appUrn,
      entitlementType,
      paymentId || null,
      subscriptionId || null,
      expiresAt ? expiresAt.toISOString() : null
    );
  }

  /**
   * Revoke entitlement to an app
   */
  async revokeEntitlement(userId: number, appUrn: string): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE app_entitlements 
      SET revoked_at = datetime('now')
      WHERE user_id = ? AND app_urn = ? AND revoked_at IS NULL
    `).run(userId, appUrn);

    return result.changes > 0;
  }

  /**
   * Get public user profile (safe to share)
   */
  getPublicProfile(user: User): Omit<User, 'password_hash' | 'stripe_customer_id'> {
    const { password_hash, stripe_customer_id, ...publicProfile } = user;
    return publicProfile;
  }
}
