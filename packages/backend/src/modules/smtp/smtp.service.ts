import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';

/** Hub SMTP connection details exposed to injector and MCP tools. */
export interface SmtpConnectionInfo {
  /** Docker-internal hostname for the Hub SMTP container. */
  host: string;
  /** SMTP submission port. */
  port: number;
  /** Security mode — "none" for internal network, "starttls" or "tls" for external. */
  security: 'none' | 'starttls' | 'tls';
}

/**
 * SmtpService — manages the Hub-wide SMTP system service (Stalwart Mail).
 *
 * This service acts as the single source of truth for whether the Hub SMTP
 * system service is enabled and provides the connection parameters that other
 * services use when injecting SMTP credentials into apps.
 */
@Injectable()
export class SmtpService {
  /** Default internal Docker hostname for the Hub SMTP container. */
  static readonly DEFAULT_HOST = 'hub-smtp';
  /** Default SMTP submission port. */
  static readonly DEFAULT_PORT = 587;

  private enabled: boolean;

  constructor(private readonly logger: LoggerService) {
    // Respect the HUB_SMTP_ENABLED env var so the feature is opt-in by default.
    this.enabled = process.env.HUB_SMTP_ENABLED === 'true';
  }

  /** Whether the Hub SMTP service is enabled. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Enable or disable the Hub SMTP service at runtime. */
  setEnabled(value: boolean): void {
    this.enabled = value;
    this.logger.info(`[SmtpService] Hub SMTP service ${value ? 'enabled' : 'disabled'}`);
  }

  /** Return SMTP connection parameters for internal use. */
  getConnectionInfo(): SmtpConnectionInfo {
    return {
      host: process.env.HUB_SMTP_HOST || SmtpService.DEFAULT_HOST,
      port: process.env.HUB_SMTP_PORT ? Number(process.env.HUB_SMTP_PORT) : SmtpService.DEFAULT_PORT,
      security: (process.env.HUB_SMTP_SECURITY as SmtpConnectionInfo['security']) || 'none',
    };
  }

  /** Return a human-readable status summary. */
  getStatus(): { enabled: boolean; connection: SmtpConnectionInfo } {
    return {
      enabled: this.enabled,
      connection: this.getConnectionInfo(),
    };
  }
}
