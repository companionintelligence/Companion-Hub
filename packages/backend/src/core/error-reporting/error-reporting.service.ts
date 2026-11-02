import { ConfigurationService } from '@/core/config/configuration.service';
import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { AppUrn } from '@ci-hub/common/types';
import { KVM_MISSING_CODE, NETWORK_OVERLAP_CODE, ROCM_KFD_MISSING_CODE } from '@/modules/app-lifecycle/commands/app-lifecycle-errors';
import { PORTAL_HTTP_ERROR_CODE, PORTAL_TIMEOUT_CODE, PORTAL_UNREACHABLE_CODE } from '@/core/portal/portal.constants';
import { QUEUE_UNAVAILABLE_CODE } from '@/modules/queue/queue.constants';
import { DOCKER_HOST_PORT_CONFLICT_PATTERN, extractConflictingHostPort } from '@/modules/network/docker-port-errors';
import { snapshotHostHealth } from './host-health';
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
  /**
   * The underlying error text behind `message`. A translation key such as COMMON_AN_ERROR_OCCURRED names
   * what the user saw, not what broke: the cause is attached as an extra, and when `message` is only a key
   * it becomes the headline that the title and the classifier read.
   */
  cause?: string;
  containers?: Array<{ name: string; state: string; logs?: string }>;
}

/**
 * - `user_environment`: the device — Docker, disk, network, host load. A warning.
 * - `app_runtime`: the app's own containers or data steps failed (a dependency, a health probe, a backup,
 *   a container that would not start). A warning: the app failed, the Hub did not.
 * - `app_config`: the marketplace manifest. An error, the app's author's to fix.
 * - `platform`: a Companion service the Hub depends on answered wrongly (Portal 5xx). An error,
 *   ours, grouped by cause across apps like the other classified kinds.
 * - `unknown`: nothing matched; grouped per app so a new failure mode stays its own issue.
 */
export type AppFailureCategory = 'user_environment' | 'app_runtime' | 'app_config' | 'platform' | 'unknown';

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
  { pattern: DOCKER_HOST_PORT_CONFLICT_PATTERN, errorClass: 'port-conflict' },
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
  // The queue dropped the channel a command went out on. The command may already have run, so it is reported
  // and not retried; the queue reconnects on its own.
  {
    pattern: /channel is closed|connection is closing|channel creation failed|is unavailable while RabbitMQ is|RPC response timed out/i,
    errorClass: 'queue-unavailable',
  },
  // The Hub restarted mid-install, so the user is asked to retry it; nothing in the app failed.
  { pattern: /Install did not finish before Hub restarted/i, errorClass: 'hub-restarted' },
  // The host refused a file or a socket the Hub writes to. Permissions are the device's to fix.
  { pattern: /\b(?:EACCES|EPERM)\b|permission denied/i, errorClass: 'host-permission-denied' },
  { pattern: /attempt to write a readonly database|disk image is malformed/i, errorClass: 'host-database-file' },
  // Companion Portal would not hand this device the app for its account.
  { pattern: /APP_INSTALL_PORTAL_DOWNLOAD_UNAUTHORIZED/i, errorClass: 'entitlement-refused' },
];

/** Failures caused by a broken app manifest in the marketplace. */
const APP_CONFIG_PATTERNS: ReadonlyArray<{ pattern: RegExp; errorClass: string }> = [
  { pattern: /invalid dynamic compose schema/i, errorClass: 'invalid-compose-schema' },
  // The catalog this Hub reads has no entry for the app: a catalog gap, not a Hub defect.
  { pattern: /Store not found for|App \S+ not found/i, errorClass: 'app-not-in-catalog' },
  // A compose file or port the app's manifest (a custom app's, in practice) cannot turn into containers.
  { pattern: /Error generating docker-compose\.yml|invalid containerPort/i, errorClass: 'invalid-app-manifest' },
  // The image reference names a tag or repository that does not exist.
  { pattern: /failed to resolve reference/i, errorClass: 'image-reference-invalid' },
];

/**
 * The app's own containers or data steps failed. Checked after the environment and manifest kinds, so a
 * Docker or disk cause that shows up inside one of these messages is still the device's.
 */
const APP_RUNTIME_PATTERNS: ReadonlyArray<{ pattern: RegExp; errorClass: string }> = [
  { pattern: /dependency failed to start/i, errorClass: 'dependency-failed' },
  { pattern: /didn't complete successfully|did not complete successfully/i, errorClass: 'service-did-not-complete' },
  { pattern: /OCI runtime create failed|unable to start container process/i, errorClass: 'container-start-failed' },
  { pattern: /health probe/i, errorClass: 'health-probe-failed' },
  { pattern: /connect ECONNREFUSED 127\.0\.0\.\d+:\d+|ECONNABORTED|timeout of \d+ms exceeded/i, errorClass: 'app-not-listening' },
  {
    pattern: /could not delete the data|failed to restore the backup|failed to copy the app files|could not snapshot/i,
    errorClass: 'app-data-step-failed',
  },
  // A container of the app that is restarting or has exited, as Docker names it in the message.
  { pattern: /\((?:Restarting|Exited|Dead)\b/i, errorClass: 'container-exited' },
  // A data volume the app still holds: the app has to be stopped first, which the user does.
  { pattern: /is in use by .*which is still running/i, errorClass: 'volume-in-use' },
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
  // A Portal request that got no answer is the device's path to Portal or a host too starved to
  // drive a socket, not Portal (#1912: one hub timed out against Portal, Cloudflare and its own
  // Postgres in the same minute). Both kinds share a class so one bad hub is one issue.
  [PORTAL_TIMEOUT_CODE]: { category: 'user_environment', errorClass: 'portal-unreachable' },
  [PORTAL_UNREACHABLE_CODE]: { category: 'user_environment', errorClass: 'portal-unreachable' },
  [PORTAL_HTTP_ERROR_CODE]: { category: 'platform', errorClass: 'portal-http-error' },
  // The queue refused the command before RabbitMQ was connected to take it. A condition that clears on its
  // own, so it is a warning, grouped by cause across apps.
  [QUEUE_UNAVAILABLE_CODE]: { category: 'user_environment', errorClass: 'queue-unavailable' },
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
  for (const { pattern, errorClass } of APP_RUNTIME_PATTERNS) {
    if (pattern.test(message)) {
      return { category: 'app_runtime', errorClass };
    }
  }
  return { category: 'unknown', errorClass: 'unclassified' };
}

/** Longest cause the event carries as an extra; a whole response body is not worth more. */
const CAUSE_EXTRA_MAX_LENGTH = 1024;

/** Longest detail a Sentry title carries; the event keeps the full message as an extra. */
const TITLE_DETAIL_MAX_LENGTH = 300;

/** A translation key such as COMMON_AN_ERROR_OCCURRED: it names what the user saw, not what broke. */
function isTranslationKeyShaped(message: string): boolean {
  return /^[A-Z][A-Z0-9_]+$/.test(message.trim());
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

    // A translation key says what the user was shown, not what broke. When the cause is known it is the
    // headline: the classifier and the title both read it.
    const headline = context.cause && isTranslationKeyShaped(context.message) ? context.cause : context.message;
    const classification = classifyAppFailure(headline, context.errorCode);
    // User-environment failures (Docker down, disk full, unsupported arch, …) are not hub bugs, and neither
    // is an app that failed on its own terms (a crash, a dependency, a health probe). Keep them visible but
    // below the error threshold.
    const level: Sentry.SeverityLevel =
      context.phase === 'post_start' ||
      context.phase === 'crash' ||
      classification.category === 'user_environment' ||
      classification.category === 'app_runtime'
        ? 'warning'
        : 'error';

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
      if (context.cause) {
        // Scrubbed before it is bounded, so a secret cannot survive by straddling the cut.
        scope.setExtra('cause', scrubString(context.cause).slice(0, CAUSE_EXTRA_MAX_LENGTH));
      }
      if (classification.errorClass === 'port-conflict') {
        // Name the port and the remedy, so the report says what to change on this device.
        const hostPort = extractConflictingHostPort(context.message);
        if (hostPort !== undefined) {
          scope.setTag('host_port', String(hostPort));
          scope.setExtra(
            'remedy',
            `Host port ${hostPort} is already in use on this device. Stop the program or container using it, or change the port this app publishes.`,
          );
        }
      }
      // Whether the host could have driven a socket when this failed. The difference between
      // "the device's network is broken" and "the device is too busy to notice its network" is
      // not in any message, and the device is a customer's: this is the only look we get.
      scope.setContext('host_health', snapshotHostHealth());

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

      // Docker and compose put the cause on a later line than the headline, and a Sentry title keeps only
      // the first line. Joining the lines keeps the cause in the title.
      const titleDetail = scrubString(headline)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' — ')
        .slice(0, TITLE_DETAIL_MAX_LENGTH);
      const detail = titleDetail ? `: ${titleDetail}` : '';
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
