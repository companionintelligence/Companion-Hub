import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockOtelEmit = vi.fn();
const mockSetGlobalLoggerProvider = vi.fn();
const mockGetLogger = vi.fn(() => ({ emit: mockOtelEmit }));
const mockAddLogRecordProcessor = vi.fn();
const mockForceFlush = vi.fn().mockResolvedValue(undefined);
const mockShutdown = vi.fn().mockResolvedValue(undefined);
const mockCreateLogger = vi.fn(() => ({
  log: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@opentelemetry/api-logs', () => ({
  SeverityNumber: {
    DEBUG: 5,
    INFO: 9,
    WARN: 13,
    ERROR: 17,
  },
  logs: {
    getLogger: mockGetLogger,
    setGlobalLoggerProvider: mockSetGlobalLoggerProvider,
  },
}));

vi.mock('@opentelemetry/exporter-logs-otlp-http', () => ({
  OTLPLogExporter: vi.fn(function OTLPLogExporter(options) {
    return options;
  }),
}));

vi.mock('@opentelemetry/sdk-logs', () => ({
  BatchLogRecordProcessor: vi.fn(function BatchLogRecordProcessor(exporter) {
    return { exporter };
  }),
  LoggerProvider: vi.fn(function LoggerProvider() {
    return {
      addLogRecordProcessor: mockAddLogRecordProcessor,
      forceFlush: mockForceFlush,
      shutdown: mockShutdown,
    };
  }),
}));

vi.mock('winston', () => {
  const format = {
    printf: vi.fn((fn) => fn),
    timestamp: vi.fn(() => 'timestamp'),
    combine: vi.fn((...parts) => parts),
    colorize: vi.fn(() => 'colorize'),
    align: vi.fn(() => 'align'),
    uncolorize: vi.fn(() => 'uncolorize'),
  };

  return {
    createLogger: mockCreateLogger,
    format,
    transports: {
      Console: vi.fn(function Console() {
        return {};
      }),
      File: vi.fn(function File() {
        return {};
      }),
    },
  };
});

describe('logger.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.OTEL_LOGS_ENABLED;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_SERVICE_VERSION;
    delete process.env.TIPI_VERSION;
  });

  it('normalizes host-only OpenTelemetry endpoints to https and /v1/logs', async () => {
    const { normalizeOpenTelemetryLogsEndpoint } = await import('../logger.service');

    expect(normalizeOpenTelemetryLogsEndpoint('logs.ci.computer')).toBe('https://logs.ci.computer/v1/logs');
  });

  it('builds OpenTelemetry logger config from environment variables', async () => {
    process.env.OTEL_LOGS_ENABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'logs.ci.computer';
    process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'authorization=Bearer token,x-api-key=abc123';
    process.env.OTEL_SERVICE_NAME = 'hub-backend';
    process.env.TIPI_VERSION = '4.7.0';

    const { getOpenTelemetryLoggerConfig } = await import('../logger.service');
    const config = getOpenTelemetryLoggerConfig('warn');

    expect(config).toEqual({
      endpoint: 'https://logs.ci.computer/v1/logs',
      headers: {
        authorization: 'Bearer token',
        'x-api-key': 'abc123',
      },
      serviceName: 'hub-backend',
      serviceVersion: '4.7.0',
      logLevel: 'warn',
    });
  });

  it('emits OpenTelemetry logs when enabled and level is allowed', async () => {
    process.env.OTEL_LOGS_ENABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'https://logs.ci.computer/v1/logs';
    process.env.OTEL_SERVICE_NAME = 'hub-backend';
    process.env.TIPI_VERSION = '4.7.0';

    const { LoggerService } = await import('../logger.service');
    const logger = new LoggerService('backend', '/tmp/logs', 'info');

    logger.error('system failure');

    expect(mockSetGlobalLoggerProvider).toHaveBeenCalledTimes(1);
    expect(mockOtelEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'system failure',
        severityNumber: 17,
        severityText: 'ERROR',
        attributes: expect.objectContaining({
          'service.name': 'hub-backend',
          'service.version': '4.7.0',
        }),
      }),
    );
  });

  it('does not emit OpenTelemetry logs below the configured log level', async () => {
    process.env.OTEL_LOGS_ENABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'https://logs.ci.computer/v1/logs';

    const { LoggerService } = await import('../logger.service');
    const logger = new LoggerService('backend', '/tmp/logs', 'warn');

    logger.info('not exported');

    expect(mockOtelEmit).not.toHaveBeenCalled();
  });

  it('swallows OpenTelemetry export errors', async () => {
    process.env.OTEL_LOGS_ENABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'https://logs.ci.computer/v1/logs';
    mockOtelEmit.mockImplementationOnce(() => {
      throw new Error('otel export failed');
    });

    const { LoggerService } = await import('../logger.service');
    const logger = new LoggerService('backend', '/tmp/logs', 'debug');

    expect(() => logger.debug('still works')).not.toThrow();
  });
});
