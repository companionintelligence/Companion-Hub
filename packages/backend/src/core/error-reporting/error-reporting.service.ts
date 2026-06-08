import { ConfigurationService } from '@/core/config/configuration.service';
import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { AppUrn } from '@ci-hub/common/types';
import { scrubString } from './sentry-scrubber';

export type AppFailurePhase =
  | 'install'
  | 'start'
  | 'restart'
  | 'stop'
  | 'uninstall'
  | 'update'
  | 'reset'
  | 'backup'
  | 'restore'
  | 'post_start'
  | 'crash';

export interface AppFailureContext {
  appUrn: AppUrn | string;
  phase: AppFailurePhase;
  message: string;
  containers?: Array<{ name: string; state: string; logs?: string }>;
}

@Injectable()
export class ErrorReportingService {
  private readonly debounce = new Map<string, number>();
  private readonly debounceMs = 30_000;

  constructor(private readonly configuration: ConfigurationService) {}

  /**
   * Consent plumbing is retained via `allowErrorMonitoring` in settings/UI.
   * Product policy: treat consent as always granted; only require a configured DSN.
   */
  isEnabled(): boolean {
    if (!process.env.SENTRY_DSN?.trim()) {
      return false;
    }

    try {
      void this.configuration.get('userSettings')?.allowErrorMonitoring;
    } catch {
      // Configuration may not be ready during early bootstrap.
    }

    return true;
  }

  addBreadcrumb(category: string, message: string, level: Sentry.SeverityLevel = 'info'): void {
    if (!this.isEnabled()) {
      return;
    }

    Sentry.addBreadcrumb({
      category,
      message: scrubString(message),
      level,
    });
  }

  captureException(error: unknown, context?: Record<string, unknown>): void {
    if (!this.isEnabled()) {
      return;
    }

    Sentry.withScope((scope) => {
      scope.setTag('component', 'backend');
      this.applyContext(scope, context);
      Sentry.captureException(error);
    });
  }

  captureMessage(message: string, level: Sentry.SeverityLevel = 'error', context?: Record<string, unknown>): void {
    if (!this.isEnabled()) {
      return;
    }

    Sentry.withScope((scope) => {
      scope.setTag('component', 'backend');
      scope.setLevel(level);
      this.applyContext(scope, context);
      Sentry.captureMessage(scrubString(message), level);
    });
  }

  reportAppFailure(context: AppFailureContext): void {
    if (!this.isEnabled()) {
      return;
    }

    const debounceKey = `${context.phase}:${context.appUrn}`;
    const now = Date.now();
    const lastSent = this.debounce.get(debounceKey);
    if (lastSent !== undefined && now - lastSent < this.debounceMs) {
      return;
    }
    this.debounce.set(debounceKey, now);

    const level: Sentry.SeverityLevel = context.phase === 'post_start' ? 'warning' : 'error';

    Sentry.withScope((scope) => {
      scope.setTag('component', 'backend');
      scope.setTag('app_urn', String(context.appUrn));
      scope.setTag('failure_phase', context.phase);
      scope.setLevel(level);
      scope.setFingerprint(['app-failure', String(context.appUrn), context.phase]);
      scope.setExtra('message', scrubString(context.message));

      if (context.containers?.length) {
        scope.setExtra(
          'containers',
          context.containers.map((container) => ({
            name: container.name,
            state: container.state,
            logs: container.logs ? scrubString(container.logs) : undefined,
          })),
        );
      }

      try {
        const settings = this.configuration.get('userSettings') as Record<string, unknown>;
        const organizationId = settings.ciHubOrganizationId;
        const deviceSlug = settings.ciHubDeviceSlug;
        if (typeof organizationId === 'string' && organizationId) {
          scope.setTag('organization_id', organizationId);
        }
        if (typeof deviceSlug === 'string' && deviceSlug) {
          scope.setTag('device_slug', deviceSlug);
        }
      } catch {
        // Best-effort pairing context.
      }

      Sentry.captureMessage(`Marketplace app ${context.phase} failed: ${context.appUrn}`, level);
    });
  }

  private applyContext(scope: Sentry.Scope, context?: Record<string, unknown>): void {
    if (!context) {
      return;
    }

    for (const [key, value] of Object.entries(context)) {
      if (value === undefined) {
        continue;
      }

      if (typeof value === 'string') {
        scope.setExtra(key, scrubString(value));
      } else {
        scope.setExtra(key, value);
      }
    }
  }
}
