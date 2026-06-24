import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/nestjs';
import { ErrorReportingService } from './error-reporting.service';

vi.mock('@sentry/nestjs', () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  withScope: vi.fn(
    (
      callback: (scope: {
        setTag: ReturnType<typeof vi.fn>;
        setLevel: ReturnType<typeof vi.fn>;
        setExtra: ReturnType<typeof vi.fn>;
        setFingerprint: ReturnType<typeof vi.fn>;
      }) => void,
    ) => {
      callback({
        setTag: vi.fn(),
        setLevel: vi.fn(),
        setExtra: vi.fn(),
        setFingerprint: vi.fn(),
      });
    },
  ),
}));

describe('ErrorReportingService', () => {
  const originalDsn = process.env.SENTRY_DSN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SENTRY_DSN = 'https://example@ingest.sentry.io/123';
  });

  afterEach(() => {
    if (originalDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalDsn;
    }
  });

  it('includes the failure message in the Sentry issue title', () => {
    const configuration = {
      get: vi.fn(() => ({ allowErrorMonitoring: true })),
    } as any;
    const service = new ErrorReportingService(configuration);

    service.reportAppFailure({
      appUrn: 'cryptpad:ci-marketplace',
      phase: 'install',
      message: 'manifest for cryptpad/cryptpad:2026.5.1 not found',
    });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'Marketplace app install failed: cryptpad:ci-marketplace: manifest for cryptpad/cryptpad:2026.5.1 not found',
      'error',
    );
  });
});
