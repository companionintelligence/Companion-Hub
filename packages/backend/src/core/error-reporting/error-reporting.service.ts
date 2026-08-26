import { ConfigurationService } from '@/core/config/configuration.service';
import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { AppUrn } from '@ci-hub/common/types';
import { KVM_MISSING_CODE, NETWORK_OVERLAP_CODE, ROCM_KFD_MISSING_CODE } from '@/modules/app-lifecycle/commands/app-lifecycle-errors';
import { scrubString } from './sentry-scrubber';
import { type UserConsent, currentUserConsent, resolveTelemetryDecision } from './telemetry-consent';

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
  /** Structured error code from AppLifecycleError (e.g. 'rocm_kfd_missing'), when available. */
  errorCode?: string;
  containers?: Array<{ name: string; state: string; logs?: string }>;
}

export type AppFailureCategory = 'user_environment' | 'app_config' | 'unknown';

export interface AppFailureClassification {
  category: AppFailureCategory;
  errorClass: string;
}

/**
 * Failures caused by the user's machine or network, not by a bug in the hub
 * or an app manifest. These are reported as warnings and grouped by error
 * class so one root cause (e.g. "Docker daemon not running") is one Sentry
 * issue instead of one issue per app.
 */
const USER_ENVIRONMENT_PATTERNS: ReadonlyArray<{ pattern: RegExp; errorClass: string }> = [
  {
    pattern: /cannot connect to the docker daemon|is the docker daemon running|failed to connect to the docker api/i,
    errorClass: 'docker-daemon-unreachable',
  },
  { pattern: /no matching manifest for \S+ in the manifest list/i, errorClass: 'image-arch-unsupported' },
  { pattern: /ports are not available|address already in use|port is already allocated/i, errorClass: 'port-conflict' },
  { pattern: /no space left on device/i, errorClass: 'disk-full' },
  { pattern: /toomanyrequests|unauthenticated pull rate limit/i, errorClass: 'registry-rate-limit' },
  { pattern: /could not select device driver/i, errorClass: 'device-driver-missing' },
  { pattern: /\/dev\/kvm/i, errorClass: 'kvm-unavailable' },
  // Docker checks compose `devices` entries in order and fails on the first one it can't
  // attach — a missing ROCm passthrough can therefore be reported as either device. This
  // regex is a fallback for messages that never went through AppLifecycleError translation;
  // translated failures are classified via ERROR_CODE_CLASSIFICATIONS below instead, since by
  // then the message reads "This app needs AMD ROCm…" and no longer names a device path.
  { pattern: /\/dev\/kfd|\/dev\/dri/i, errorClass: 'rocm-unavailable' },
  { pattern: /mounts denied|invalid mount config/i, errorClass: 'mount-denied' },
  { pattern: /failed to set up container networking|driver failed programming external connectivity/i, errorClass: 'docker-networking' },
  { pattern: /failed to pull image|tls handshake timeout|i\/o timeout/i, errorClass: 'image-pull-failed' },
];

/** Failures caused by a broken app manifest in the marketplace. */
const APP_CONFIG_PATTERNS: ReadonlyArray<{ pattern: RegExp; errorClass: string }> = [
  { pattern: /invalid dynamic compose schema/i, errorClass: 'invalid-compose-schema' },
];

/**
 * Structured errorCode → classification, checked before message regexes. AppLifecycleError
 * subclasses (ROCm/KVM missing, network overlap) already know their own root cause; deriving
 * it from their friendly, already-translated message text would be a fragile round-trip and
 * would miss cases like ROCM_KFD_MISSING_USER_MESSAGE, which reads "This app needs AMD ROCm…"
 * and matches none of the device-path regexes above.
 */
const ERROR_CODE_CLASSIFICATIONS: Readonly<Record<string, AppFailureClassification>> = {
  [ROCM_KFD_MISSING_CODE]: { category: 'user_environment', errorClass: 'rocm-unavailable' },
  [KVM_MISSING_CODE]: { category: 'user_environment', errorClass: 'kvm-unavailable' },
  [NETWORK_OVERLAP_CODE]: { category: 'user_environment', errorClass: 'network-overlap' },
};

export function classifyAppFailure(message: string, errorCode?: string): AppFailureClassification {
  const knownClassification = errorCode ? ERROR_CODE_CLASSIFICATIONS[errorCode] : undefined;
  if (knownClassification) {
    return knownClassification;
  }
  for (const { pattern, errorClass } of USER_ENVIRONMENT_PATTERNS) {
    if (pattern.test(message)) {
      return { category: 'user_environment', errorClass };
    }
  }
  for (const { pattern, errorClass } of APP_CONFIG_PATTERNS) {
    if (pattern.test(message)) {
      return { category: 'app_config', errorClass };
    }
  }
  return { category: 'unknown', errorClass: 'unclassified' };
}

function appFailureTitle(phase: AppFailurePhase, appUrn: string, detail: string): string {
  // "Marketplace app crash failed" read like the crash handler itself broke.
  if (phase === 'crash') {
    return `Marketplace app crashed: ${appUrn}${detail}`;
  }
  return `Marketplace app ${phase} failed: ${appUrn}${detail}`;
}

@Injectable()
export class ErrorReportingService {
  private readonly debounce = new Map<string, number>();
  private readonly debounceMs = 30_000;
  private readonly messageDebounceMs = 5 * 60_000;

  constructor(private readonly configuration: ConfigurationService) {}

  /**
   * Whether this service may report right now.
   *
   * Belt to `beforeSend`'s braces: capture sites short-circuit here so we do not
   * build scopes and scrub payloads for events that would be dropped anyway,
   * while `beforeSend` stays the backstop for anything the SDK's own
   * integrations capture without going through this service.
   */
  isEnabled(): boolean {
    return resolveTelemetryDecision({
      env: process.env,
      dsn: process.env.SENTRY_DSN,
      consent: this.userConsent(),
    }).enabled;
  }

  /**
   * Prefer the live in-memory setting — `setUserSettings` updates it in the same
   * tick as the write — and fall back to the disk-backed value when the
   * configuration is not ready yet (early bootstrap) or holds no boolean.
   */
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

  captureMessage(
    message: string,
    level: Sentry.SeverityLevel = 'error',
    context?: Record<string, unknown>,
    options?: { debounceKey?: string; debounceMs?: number },
  ): void {
    if (!this.isEnabled()) {
      return;
    }

    if (options?.debounceKey) {
      const now = Date.now();
      const lastSent = this.debounce.get(options.debounceKey);
      const debounceMs = options.debounceMs ?? this.messageDebounceMs;
      if (lastSent !== undefined && now - lastSent < debounceMs) {
        return;
      }
      this.debounce.set(options.debounceKey, now);
    }

    Sentry.withScope((scope) => {
      scope.setTag('component', 'backend');
      scope.setLevel(level);
      this.applyContext(scope, context);
      Sentry.captureMessage(scrubString(message), level);
    });
  }

  captureWarning(message: string, context?: Record<string, unknown>, options?: { debounceKey?: string; debounceMs?: number }): void {
    this.captureMessage(message, 'warning', context, options);
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

    const classification = classifyAppFailure(context.message, context.errorCode);
    // User-environment failures (Docker down, disk full, unsupported arch, …)
    // are not hub bugs; keep them visible but below the error threshold.
    const level: Sentry.SeverityLevel = context.phase === 'post_start' || classification.category === 'user_environment' ? 'warning' : 'error';

    Sentry.withScope((scope) => {
      scope.setTag('component', 'backend');
      scope.setTag('app_urn', String(context.appUrn));
      scope.setTag('failure_phase', context.phase);
      scope.setTag('failure_category', classification.category);
      scope.setTag('error_class', classification.errorClass);
      scope.setLevel(level);
      // Classified failures group by root cause across apps; unclassified ones
      // keep the historical per-app grouping so new failure modes stay distinct.
      scope.setFingerprint(
        classification.category === 'unknown'
          ? ['app-failure', String(context.appUrn), context.phase]
          : ['app-failure', context.phase, classification.errorClass],
      );
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

      const scrubbedMessage = scrubString(context.message).trim();
      const detail = scrubbedMessage ? `: ${scrubbedMessage}` : '';
      Sentry.captureMessage(appFailureTitle(context.phase, String(context.appUrn), detail), level);
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
