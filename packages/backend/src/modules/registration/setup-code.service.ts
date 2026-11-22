import { randomInt, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';

/** Crockford base32: no I, L, O or U, so a code read off a screen or a log is typed back right. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

/** Wrong codes, from anywhere, before every code is refused for {@link LOCKOUT_MS}. */
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60_000;

/** The header a browser on the setup page sends the code in. */
export const SETUP_CODE_HEADER = 'x-ci-hub-setup-code';

/** What a refused setup request is answered with, so the page knows to ask for the code. */
export const SETUP_CODE_REQUIRED = 'SETUP_CODE_REQUIRED';

/**
 * The one-time setup code an unpaired Hub asks for before it pairs.
 *
 * ⚠ AN ADDRESS IS NOT PRESENCE. A Hub that holds no registration used to pair with whoever reached
 * its API port: Portal hands out pairing codes for the caller's own organization, so any caller
 * could pair the Hub into theirs and lock the owner out. "From this Hub's machine" was no answer
 * either: an installed app that dials its own network's gateway on the published port arrives from
 * the Hub network's gateway, exactly as the host does (measured on Docker 29, 2026-11-18).
 *
 * So pairing needs proof that the caller has the Hub's machine: the host-local key (`cihub`, the
 * desktop app, CI-OS's setup service), a person who may manage a registered Hub, or this code. The
 * code lives in `state/setup-code`, which only the machine's own user can read, and the page that
 * pairs from another computer is handed it by `cihub setup-code` (a ready-to-open link) or the
 * desktop app. It exists only while the Hub is unpaired: written when the Hub has no registration,
 * removed when pairing succeeds, written anew when the registration is reset.
 *
 * The code is 8 characters from a 32-letter alphabet (40 bits), and every code is refused for 15
 * minutes after 10 wrong ones from anywhere, so guessing it is out of reach. The lockout is global
 * on purpose: a caller can change address, and the owner, who has the host-local key, is never
 * held by it.
 */
@Injectable()
export class SetupCodeService {
  private failures = 0;
  private lockedUntil = 0;

  constructor(
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}

  /** Where the code is kept: `<data>/state/setup-code`. */
  public codePath(): string {
    return path.join(this.config.getConfig().directories.dataDir, 'state', 'setup-code');
  }

  /**
   * Make sure an unpaired Hub has a code. Keeps the one on disk, so a restart does not invalidate a
   * link `cihub` already printed. Never throws: a Hub that cannot write the file can still be paired
   * with the host-local key, and says so.
   */
  public async ensure(): Promise<void> {
    try {
      if (await this.read()) {
        return;
      }
      const code = generateSetupCode();
      await fs.mkdir(path.dirname(this.codePath()), { recursive: true });
      await fs.writeFile(this.codePath(), `${code}\n`, { mode: 0o600 });
      this.logger.info('This Hub is not paired. Its setup code is in state/setup-code; `cihub setup-code` prints it with a link to open.');
    } catch (error) {
      this.logger.warn(
        `Could not write the setup code: ${error instanceof Error ? error.message : String(error)}. Pair with \`cihub register\` on this machine.`,
      );
    }
  }

  /** Remove the code once the Hub is paired; it is no use after that. Never throws. */
  public async retire(): Promise<void> {
    try {
      await fs.rm(this.codePath(), { force: true });
    } catch (error) {
      this.logger.warn(`Could not remove the setup code: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Whether `presented` is the current code. Compared in constant time, after normalising what a
   * person types (case, spaces, dashes, and the letters Crockford reads as digits). A wrong code
   * counts towards the lockout; while it holds, every code is refused.
   */
  public async verify(presented: string | undefined | null, now: number = Date.now()): Promise<boolean> {
    if (typeof presented !== 'string' || !presented.trim()) {
      return false;
    }
    if (now < this.lockedUntil) {
      return false;
    }

    const expected = await this.read();
    const given = normaliseSetupCode(presented);
    const matches = expected !== null && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));

    if (matches) {
      this.failures = 0;
      return true;
    }

    this.failures += 1;
    if (this.failures >= MAX_FAILURES) {
      this.failures = 0;
      this.lockedUntil = now + LOCKOUT_MS;
      this.logger.warn(`${MAX_FAILURES} wrong setup codes: refusing every setup code for ${LOCKOUT_MS / 60_000} minutes`);
    }
    return false;
  }

  private async read(): Promise<string | null> {
    try {
      const raw = (await fs.readFile(this.codePath(), 'utf8')).trim();
      const code = normaliseSetupCode(raw);
      return code.length === CODE_LENGTH ? code : null;
    } catch {
      return null;
    }
  }
}

/** A new code, formatted for people: `ABCD-EFGH`. */
export function generateSetupCode(): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** What is compared: upper case, no separators, and O/I/L read as 0/1/1 as Crockford does. */
export function normaliseSetupCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}
