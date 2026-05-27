import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { SmtpRegistryService } from './smtp-registry.service';
import { SmtpService } from './smtp.service';

/** SMTP env-var field categories detected by pattern matching. */
export type SmtpEnvVarCategory = 'host' | 'port' | 'user' | 'pass' | 'from' | 'enable' | 'security';

/**
 * Patterns used to recognise SMTP-related environment variable names.
 * Each category maps to a list of regexes that are tested against the variable name.
 */
export const SMTP_PATTERNS: Record<SmtpEnvVarCategory, RegExp[]> = {
  host: [/SMTP.?HOST/i, /SMTP.?ADDR/i, /SMTP.?SERVER/i, /MAILER.+HOST/i, /MAIL.?SERVER/i],
  port: [/SMTP.?PORT/i, /MAILER.+PORT/i, /MAIL.?PORT/i],
  user: [/SMTP.?USER/i, /SMTP.?USERNAME/i, /MAILER.+USER/i],
  pass: [/SMTP.?PASS/i, /SMTP.?PASSWORD/i, /MAILER.+PASSWORD/i],
  from: [/SMTP.?FROM/i, /MAIL.?FROM/i, /FROM.?EMAIL/i, /FROM.?ADDRESS/i],
  enable: [/SMTP.?ENABLE/i, /MAILER.?ENABLE/i],
  security: [/SMTP.?SECURITY/i, /SMTP.?SECURE/i],
};

/**
 * Detects whether an environment variable name matches a known SMTP category.
 * Returns the category name, or `null` if the variable is not SMTP-related.
 */
export function detectSmtpCategory(envVarName: string): SmtpEnvVarCategory | null {
  for (const [category, patterns] of Object.entries(SMTP_PATTERNS) as [SmtpEnvVarCategory, RegExp[]][]) {
    for (const pattern of patterns) {
      if (pattern.test(envVarName)) {
        return category;
      }
    }
  }
  return null;
}

/**
 * SmtpInjectorService — scans an app's env map for SMTP-related variables and
 * auto-populates them with Hub-managed SMTP credentials when the Hub SMTP
 * service is running. Variables that already have a value are never overwritten.
 */
@Injectable()
export class SmtpInjectorService {
  constructor(
    private readonly logger: LoggerService,
    private readonly smtpService: SmtpService,
    private readonly smtpRegistry: SmtpRegistryService,
  ) {}

  /**
   * Scan `envMap` for SMTP-related keys and inject Hub SMTP credentials where
   * the variable is currently empty. Skips injection when the Hub SMTP service
   * is not enabled.
   *
   * @param appName  - Short app name (e.g. "nextcloud", "gitea")
   * @param envMap   - Mutable env map that will be updated in place
   * @param domain   - Hub public domain (e.g. "yourdomain.com" or "hub.local")
   */
  async injectSmtpEnv(appName: string, envMap: Map<string, string>, domain: string): Promise<void> {
    if (!this.smtpService.isEnabled()) {
      return;
    }

    const smtpInfo = this.smtpService.getConnectionInfo();
    const credentials = await this.smtpRegistry.getOrCreateAppCredentials(appName);
    const fromAddress = `${appName}@${domain}`;

    const smtpValues: Record<SmtpEnvVarCategory, string> = {
      host: smtpInfo.host,
      port: String(smtpInfo.port),
      user: credentials.username,
      pass: credentials.password,
      from: fromAddress,
      enable: 'true',
      security: smtpInfo.security,
    };

    let injectedCount = 0;

    for (const [key, currentValue] of envMap.entries()) {
      if (currentValue && currentValue.trim() !== '') {
        continue;
      }

      const category = detectSmtpCategory(key);
      if (category === null) {
        continue;
      }

      const fillValue = smtpValues[category];
      envMap.set(key, fillValue);
      injectedCount++;
    }

    if (injectedCount > 0) {
      this.logger.info(`[SmtpInjector] Injected ${injectedCount} SMTP env vars for app "${appName}"`);
    }
  }
}
