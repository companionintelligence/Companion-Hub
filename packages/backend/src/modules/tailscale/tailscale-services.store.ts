import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '@/common/constants';
import { PRIVATE_STATE_FILE_MODE } from '@/common/helpers/env-helpers';
import type { AppUrn } from '@ci-hub/common/types';

/** The tag the Hub's own Tailscale node carries unless the operator names another. */
export const DEFAULT_TAILSCALE_SERVICES_TAG = 'tag:ci-hub';

/** A Tailscale OAuth client (trust credential) the operator gave the Hub for Tailscale Services. */
export interface TailscaleOAuthClient {
  clientId: string;
  clientSecret: string;
  /** The tag the Hub's node joins with, and every Service it defines carries. */
  tag: string;
}

/** One Tailscale Service the Hub defined for an app. */
export interface PublishedTailscaleService {
  /** `svc:<label>`, as the Tailscale API and `tailscale serve --service` name it. */
  name: string;
  /** `<label>.<tailnet>.ts.net`: the address the app answers on. */
  fqdn: string;
}

interface ServicesFile {
  /**
   * Written once per install into every Service's `comment`. A Service whose comment carries
   * another value is someone else's, so the Hub neither reuses nor deletes it.
   */
  installId?: string;
  /** The Hub dashboard's origin on the tailnet, where a Service's login redirect sends a visitor. */
  hubOrigin?: string | null;
  services?: Record<string, PublishedTailscaleService>;
}

const oauthPath = () => path.join(DATA_DIR, 'state', 'tailscale-oauth.json');
const servicesPath = () => path.join(DATA_DIR, 'state', 'tailscale-services.json');

/** Tailscale tags are `tag:` and then letters, digits and dashes, starting with a letter. */
export function isValidTailscaleTag(tag: string): boolean {
  return /^tag:[a-zA-Z][a-zA-Z0-9-]{0,62}$/.test(tag);
}

/** The Service label for an app: one DNS label, lower-case, at most 63 characters. Empty if nothing usable is left. */
export function serviceLabelFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}

/**
 * What the Hub keeps about Tailscale Services between restarts.
 *
 * ⚠ TWO FILES, AND ONLY ONE IS SECRET. The OAuth client's secret mints tagged auth keys and edits
 * the tailnet's Services, so it lives in `state/tailscale-oauth.json` at 0600, apart from the record
 * of published Services that the forward-auth host map reads on every rebuild.
 *
 * Reads are cached by file mtime, so the forward-auth resolver and the sync can call these freely.
 */
export class TailscaleServicesStore {
  private readonly logger = new Logger(TailscaleServicesStore.name);
  private oauthCache: { mtimeMs: number; value: TailscaleOAuthClient | null } | null = null;
  private servicesCache: { mtimeMs: number; value: ServicesFile } | null = null;

  constructor(
    private readonly oauthFile: string = oauthPath(),
    private readonly servicesFile: string = servicesPath(),
  ) {}

  /** The saved OAuth client, else one from `TAILSCALE_OAUTH_CLIENT_ID` / `_SECRET` (the Hub Pool's), else null. */
  readOAuthClient(): TailscaleOAuthClient | null {
    const saved = this.readSavedOAuthClient();
    if (saved) return saved;
    const clientId = process.env.TAILSCALE_OAUTH_CLIENT_ID?.trim();
    const clientSecret = process.env.TAILSCALE_OAUTH_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) return null;
    const tag = process.env.TAILSCALE_SERVICES_TAG?.trim() || DEFAULT_TAILSCALE_SERVICES_TAG;
    return { clientId, clientSecret, tag };
  }

  /** Whether the OAuth client came from the operator's setup in the Hub (true) or from the env (false). */
  hasSavedOAuthClient(): boolean {
    return this.readSavedOAuthClient() !== null;
  }

  async saveOAuthClient(client: TailscaleOAuthClient): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.oauthFile), { recursive: true });
    const tmp = `${this.oauthFile}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, `${JSON.stringify(client, null, 2)}\n`, { mode: PRIVATE_STATE_FILE_MODE });
    await fs.promises.chmod(tmp, PRIVATE_STATE_FILE_MODE);
    await fs.promises.rename(tmp, this.oauthFile);
    this.oauthCache = null;
  }

  async forgetOAuthClient(): Promise<void> {
    await fs.promises.rm(this.oauthFile, { force: true });
    this.oauthCache = null;
  }

  /** The Services the Hub published, by app. */
  publishedServices(): Map<AppUrn, PublishedTailscaleService> {
    const services = this.readServicesFile().services ?? {};
    return new Map(Object.entries(services) as Array<[AppUrn, PublishedTailscaleService]>);
  }

  /** The app a Service hostname belongs to, if the Hub published one there. */
  appForServiceHost(host: string): AppUrn | null {
    const wanted = host.toLowerCase();
    for (const [appUrn, service] of this.publishedServices()) {
      if (service.fqdn === wanted) return appUrn;
    }
    return null;
  }

  /** The Hub dashboard's tailnet origin, recorded by the last sync that published Services. */
  hubOrigin(): string | null {
    return this.readServicesFile().hubOrigin ?? null;
  }

  /** This install's marker, created on first use. */
  async installId(): Promise<string> {
    const current = this.readServicesFile();
    if (current.installId) return current.installId;
    const installId = randomBytes(8).toString('hex');
    await this.writeServicesFile({ ...current, installId });
    return installId;
  }

  async savePublished(services: Map<AppUrn, PublishedTailscaleService>, hubOrigin: string | null): Promise<void> {
    const current = this.readServicesFile();
    const next: ServicesFile = { ...current, hubOrigin, services: Object.fromEntries(services) };
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    await this.writeServicesFile(next);
  }

  private readSavedOAuthClient(): TailscaleOAuthClient | null {
    const stat = this.statOrNull(this.oauthFile);
    if (!stat) {
      this.oauthCache = null;
      return null;
    }
    if (this.oauthCache?.mtimeMs === stat.mtimeMs) return this.oauthCache.value;
    let value: TailscaleOAuthClient | null = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.oauthFile, 'utf-8')) as Partial<TailscaleOAuthClient>;
      if (typeof parsed.clientId === 'string' && typeof parsed.clientSecret === 'string' && parsed.clientId && parsed.clientSecret) {
        value = {
          clientId: parsed.clientId,
          clientSecret: parsed.clientSecret,
          tag: typeof parsed.tag === 'string' && isValidTailscaleTag(parsed.tag) ? parsed.tag : DEFAULT_TAILSCALE_SERVICES_TAG,
        };
      }
    } catch (error) {
      this.logger.warn(`Cannot read ${this.oauthFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.oauthCache = { mtimeMs: stat.mtimeMs, value };
    return value;
  }

  private readServicesFile(): ServicesFile {
    const stat = this.statOrNull(this.servicesFile);
    if (!stat) {
      this.servicesCache = null;
      return {};
    }
    if (this.servicesCache?.mtimeMs === stat.mtimeMs) return this.servicesCache.value;
    let value: ServicesFile = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.servicesFile, 'utf-8')) as ServicesFile;
      value = {
        installId: typeof parsed.installId === 'string' ? parsed.installId : undefined,
        hubOrigin: typeof parsed.hubOrigin === 'string' ? parsed.hubOrigin : null,
        services: Object.fromEntries(
          Object.entries(parsed.services ?? {}).filter(
            ([, entry]) => typeof entry?.name === 'string' && entry.name.startsWith('svc:') && typeof entry.fqdn === 'string',
          ),
        ),
      };
    } catch (error) {
      this.logger.warn(`Cannot read ${this.servicesFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.servicesCache = { mtimeMs: stat.mtimeMs, value };
    return value;
  }

  private async writeServicesFile(value: ServicesFile): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.servicesFile), { recursive: true });
    const tmp = `${this.servicesFile}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
    await fs.promises.rename(tmp, this.servicesFile);
    this.servicesCache = null;
  }

  private statOrNull(file: string): fs.Stats | null {
    try {
      return fs.statSync(file);
    } catch {
      return null;
    }
  }
}

/** One per process: the forward-auth resolver, the sync and the setup endpoints share it. */
export const tailscaleServicesStore = new TailscaleServicesStore();
