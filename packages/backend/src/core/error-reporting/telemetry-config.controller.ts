import { Controller, Get, HttpCode } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

import { ConfigurationService } from '@/core/config/configuration.service';
import { type UserConsent, currentUserConsent, resolveConsentDecision } from './telemetry-consent';

/**
 * Runtime error-reporting consent, for the components that cannot read
 * `state/settings.json` for themselves — the browser bundle above all.
 *
 * A DSN baked into the frontend bundle at build time cannot be revoked
 * afterwards, so without this the "Allow error monitoring" switch and the
 * `CI_TELEMETRY` / `CI_LOCAL_ONLY` kill switches would apply to the backend
 * only and the browser would keep reporting regardless. The same
 * unauthenticated `{ enabled, reason }` contract is served by CI-Server,
 * Companion-Planning, CI-Spellbook and CI-Spatial-Companion-WebXR.
 *
 * Deliberately unauthenticated: the browser must be able to ask before login,
 * because errors happen on the login page too. It exposes no secret — never the
 * DSN, only whether reporting is permitted and why not.
 */
@Controller('config')
export class TelemetryConfigController {
  constructor(private readonly configuration: ConfigurationService) {}

  @Get('telemetry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Whether error reporting is permitted on this Hub' })
  @ApiResponse({ status: 200, description: 'Consent decision. Never includes a DSN.' })
  telemetry(): { enabled: boolean; reason: string | null } {
    // No DSN dimension: the browser and the desktop shell carry their own
    // (`VITE_SENTRY_DSN`, `SENTRY_DESKTOP_DSN`), so answering `no-dsn` from the
    // backend's `SENTRY_DSN` would wrongly silence a client that has one.
    const { enabled, reason } = resolveConsentDecision({ env: process.env, consent: this.userConsent() });

    return { enabled, reason };
  }

  private userConsent(): UserConsent {
    try {
      const value = this.configuration.get('userSettings')?.allowErrorMonitoring;

      if (typeof value === 'boolean') {
        return value;
      }
    } catch {
      // Configuration may not be ready during early bootstrap.
    }

    return currentUserConsent();
  }
}
