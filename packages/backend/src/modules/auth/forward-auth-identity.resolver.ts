import { SessionUserCache } from '@/core/cache/session-user.cache';
import { DATABASE, type Database } from '@/core/database/database.module';
import { userDirectory } from '@/core/database/drizzle/schema';
import { LoggerService } from '@/core/logger/logger.service';
import { FederatedIdentityRepository } from '@/modules/user/federated-identity.repository';
import { UserRepository } from '@/modules/user/user.repository';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm/sql';
import { loadSessionUser } from './auth.middleware';
import { type ForwardAuthStableId, HUB_ISSUER_PREFIX } from './utils/forward-auth-signing';

/** How long a Portal subject's Hub person is remembered on the Bearer path. */
const PORTAL_SUBJECT_TTL_MS = 60_000;

/**
 * Who forward auth is signing for, for good: the Hub person's stable id, and on the Portal Bearer
 * path, which Hub person a Portal subject is.
 *
 * Forward auth runs on every request an app serves, so nothing here may read a row per request:
 * a person's `public_id` never changes and a row's id is never reused, so it is read once; the
 * directory is one row for the life of the database; the Bearer path's person comes through the
 * same short-lived session-user cache the cookie path uses.
 *
 * A failed read never fails the request. It signs the username alone, exactly what forward auth
 * signed before stable ids existed, and an app that keys on the id falls back to the username for
 * that one request.
 */
@Injectable()
export class ForwardAuthIdentityResolver {
  private readonly publicIds = new Map<number, string>();
  private readonly portalSubjects = new Map<string, { userId: number; expiresAt: number }>();
  private issuer?: Promise<string>;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly userRepository: UserRepository,
    private readonly federatedIdentities: FederatedIdentityRepository,
    private readonly sessionUserCache: SessionUserCache,
    private readonly logger: LoggerService,
  ) {}

  /** The stable id to sign beside `userId`'s username, or null when it cannot be read. */
  public async stableIdFor(userId: number): Promise<ForwardAuthStableId | null> {
    try {
      const [issuer, publicId] = await Promise.all([this.getIssuer(), this.getPublicId(userId)]);
      return publicId ? { issuer, userId: publicId } : null;
    } catch (error) {
      this.logger.warn(`Forward auth could not read the stable id of user ${userId}; signing the username alone: ${describe(error)}`);
      return null;
    }
  }

  /**
   * The active Hub person a verified Portal subject is bound to, as forward auth should name them:
   * their Hub username and stable id. Null for a subject no Hub person is bound to (an org member
   * who has never signed in to this Hub), for a revoked person, and when it cannot be read; the
   * Bearer path then names the caller by their Portal claims, as before.
   *
   * Naming the Hub person rather than the Portal email is what makes one person one identity to
   * every app behind Traefik, whichever client they use: a Portal email change does not touch the
   * Hub username, so the two drift apart, and the cookie path has always signed the username.
   */
  public async personForPortalSubject(
    portalIssuer: string,
    subject: string,
  ): Promise<{ username: string; stableId: ForwardAuthStableId | null } | null> {
    try {
      const userId = await this.userIdForPortalSubject(portalIssuer, subject);
      if (userId == null) {
        return null;
      }

      const user = await loadSessionUser(this.sessionUserCache, this.userRepository, userId);
      if (!user || user.accessStatus === 'revoked') {
        return null;
      }

      return { username: user.username, stableId: await this.stableIdFor(userId) };
    } catch (error) {
      this.logger.warn(`Forward auth could not resolve the Hub person of a Portal subject; naming them by their claims: ${describe(error)}`);
      return null;
    }
  }

  private getIssuer(): Promise<string> {
    this.issuer ??= this.readIssuer().catch((error: unknown) => {
      // Not remembered, so the next request can recover.
      this.issuer = undefined;
      throw error;
    });
    return this.issuer;
  }

  private async readIssuer(): Promise<string> {
    // Migration 0066 inserted the row. A database restored without it gets one now rather than
    // never naming anyone by id.
    await this.db.insert(userDirectory).values({ id: 'self' }).onConflictDoNothing();
    const [row] = await this.db.select({ directoryId: userDirectory.directoryId }).from(userDirectory).where(eq(userDirectory.id, 'self'));
    if (!row) {
      throw new Error('user_directory has no row');
    }
    return `${HUB_ISSUER_PREFIX}${row.directoryId}`;
  }

  private async getPublicId(userId: number): Promise<string | undefined> {
    const cached = this.publicIds.get(userId);
    if (cached) {
      return cached;
    }

    const publicId = await this.userRepository.getPublicId(userId);
    if (publicId) {
      this.publicIds.set(userId, publicId);
    }
    return publicId;
  }

  private async userIdForPortalSubject(portalIssuer: string, subject: string): Promise<number | null> {
    const key = `${portalIssuer}\n${subject}`;
    const cached = this.portalSubjects.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.userId;
    }

    const link = await this.federatedIdentities.findByIssuerSubject(portalIssuer, subject);
    if (!link) {
      // Not remembered: the subject can be admitted at any moment.
      this.portalSubjects.delete(key);
      return null;
    }

    this.portalSubjects.set(key, { userId: link.userId, expiresAt: Date.now() + PORTAL_SUBJECT_TTL_MS });
    return link.userId;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
