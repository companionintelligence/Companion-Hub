import { Injectable } from '@nestjs/common';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { LoggerService } from '@/core/logger/logger.service';
import { type MemoryConnectionRow, MemoryConnectionRepository, type MemoryConnectionState } from './memory-connection.repository';

/** Credentials ready to inject into a consumer app's env. */
export interface InjectableMemoryCreds {
  /** Resolved Companion Memory URL. */
  url: string;
  /** Decrypted, memory-scoped api key. */
  token: string;
}

/**
 * Owns the Hub's durable, encrypted custody of each app's Companion Memory
 * connection: the per-app state machine and the CI-Server-issued api key.
 *
 * The key is held **encrypted at rest** (AES-256-GCM via {@link EncryptionService},
 * salted by app URN). The Hub must retain the raw value — unlike its own MCP
 * keys (stored as hashes) — because CI-Server reveals the key only once and the
 * Hub re-emits it into the app's container env on every restart.
 *
 * This service deliberately has NO dependency on the apps/app-lifecycle modules,
 * so it can be injected into env generation (AppHelpers) without a cycle.
 */
@Injectable()
export class MemoryConnectionService {
  constructor(
    private readonly repo: MemoryConnectionRepository,
    private readonly encryption: EncryptionService,
    private readonly logger: LoggerService,
  ) {}

  /** Current connection state for an app; `unconfigured` when never touched. */
  async getState(appUrn: string): Promise<MemoryConnectionState> {
    const row = await this.repo.findByAppUrn(appUrn);

    return row?.state ?? 'unconfigured';
  }

  /** Whether the app currently has a stored, connected memory key. */
  async isConnected(appUrn: string): Promise<boolean> {
    const row = await this.repo.findByAppUrn(appUrn);

    return row?.state === 'connected' && !!row.encryptedKey;
  }

  /**
   * Persist a successful connection: encrypt + store the CI-Server key and the
   * resolved memory URL, and flip state to `connected`.
   */
  async storeConnected(appUrn: string, serverUrl: string, rawKey: string): Promise<void> {
    await this.repo.upsert(appUrn, {
      state: 'connected',
      serverUrl,
      encryptedKey: this.encryption.encrypt(rawKey, appUrn),
    });

    this.logger.info(`[MemoryConnect] stored connection for ${appUrn}`);
  }

  /**
   * The creds to inject into the consumer app's env, or `null` when the app is
   * not connected (or the stored ciphertext fails to decrypt — treated as
   * not-connected so a corrupt row degrades gracefully rather than crashing env
   * generation).
   */
  async getInjectableCreds(appUrn: string): Promise<InjectableMemoryCreds | null> {
    const row = await this.repo.findByAppUrn(appUrn);

    if (!row || row.state !== 'connected' || !row.encryptedKey || !row.serverUrl) {
      return null;
    }

    try {
      return { url: row.serverUrl, token: this.encryption.decrypt(row.encryptedKey, appUrn) };
    } catch (err) {
      this.logger.error(`[MemoryConnect] failed to decrypt stored key for ${appUrn}`, err);

      return null;
    }
  }

  /** Record that the user explicitly skipped connecting (do not re-prompt). */
  async markSkipped(appUrn: string): Promise<void> {
    await this.repo.upsert(appUrn, { state: 'skipped' });

    this.logger.info(`[MemoryConnect] ${appUrn} marked skipped`);
  }

  /**
   * Record that the operator supplied memory creds manually at install time, so
   * the Hub never prompts to connect and never manages a key for this app.
   */
  async markManual(appUrn: string): Promise<void> {
    await this.repo.upsert(appUrn, { state: 'manual' });
  }

  /**
   * Clear a stored connection (e.g. a detected 401 after ci-memory reset, or a
   * user "Disconnect"), returning the app to `unconfigured` so it re-prompts.
   * Drops the stored key.
   */
  async clear(appUrn: string): Promise<void> {
    await this.repo.upsert(appUrn, { state: 'unconfigured', encryptedKey: null, serverUrl: null });

    this.logger.info(`[MemoryConnect] cleared connection for ${appUrn}`);
  }

  /** Remove all connection state for an app (called when the app is uninstalled). */
  async remove(appUrn: string): Promise<void> {
    const removed = await this.repo.deleteByAppUrn(appUrn);

    if (removed > 0) {
      this.logger.info(`[MemoryConnect] removed connection row for ${appUrn} on uninstall`);
    }
  }

  /** Raw row accessor (for callers that need the full record). */
  async getRow(appUrn: string): Promise<MemoryConnectionRow | undefined> {
    return this.repo.findByAppUrn(appUrn);
  }
}
