import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';
import { type Logger as OtelLogger, SeverityNumber, logs } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { Injectable } from '@nestjs/common';
import { type Logger, createLogger, format, transports } from 'winston';

export const LOG_LEVEL_ENUM = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
} as const;
export type LogLevel = (typeof LOG_LEVEL_ENUM)[keyof typeof LOG_LEVEL_ENUM];

const DEFAULT_OTEL_LOGS_ENDPOINT = 'https://logs.ci.computer/v1/logs';
const LOG_LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const;

const { printf, timestamp, combine, colorize, align } = format;

const printFile = printf((info) => `${info.timestamp} - ${info.level} > ${info.message}`);
const printConsole = printf((info) => `${info.level} > ${info.message}`);

const fileFormat = combine(format.uncolorize(), timestamp(), align(), printFile);
const consoleFormat = combine(colorize(), printConsole);

type Transports = transports.ConsoleTransportInstance | transports.FileTransportInstance;
type OpenTelemetryLoggerConfig = {
  endpoint: string;
  headers?: Record<string, string>;
  serviceName: string;
  serviceVersion?: string;
};
type OpenTelemetryGlobalState = typeof globalThis & {
  __ciOsHubOpenTelemetryShutdownRegistered?: boolean;
};

let openTelemetryLoggerState: {
  key: string;
  logger: OtelLogger;
  provider: LoggerProvider;
} | null = null;

const normalizeLogLevel = (logLevel: string | undefined) =>
  logLevel && logLevel in LOG_LEVEL_PRIORITY ? (logLevel as LogLevel) : LOG_LEVEL_ENUM.info;

export const shouldEmitLogLevel = (level: string, minimumLevel: string) =>
  (LOG_LEVEL_PRIORITY[normalizeLogLevel(level)] ?? LOG_LEVEL_PRIORITY.info) >=
  (LOG_LEVEL_PRIORITY[normalizeLogLevel(minimumLevel)] ?? LOG_LEVEL_PRIORITY.info);

export const normalizeOpenTelemetryLogsEndpoint = (endpoint: string) => {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return DEFAULT_OTEL_LOGS_ENDPOINT;
  }

  const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProtocol);

  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/v1/logs';
  }

  return url.toString();
};

export const parseOpenTelemetryHeaders = (value: string | undefined) => {
  const headerString = value?.trim();

  if (!headerString) {
    return undefined;
  }

  const headers = Object.fromEntries(
    headerString
      .split(',')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .flatMap((pair) => {
        const separatorIndex = pair.indexOf('=');
        if (separatorIndex <= 0) {
          return [];
        }

        const key = pair.slice(0, separatorIndex).trim();
        const headerValue = pair.slice(separatorIndex + 1).trim();

        if (!key || !headerValue) {
          return [];
        }

        return [[key, headerValue] as const];
      }),
  );

  return Object.keys(headers).length ? headers : undefined;
};

export const getOpenTelemetryLoggerConfig = (logLevel: LogLevel, env = process.env) => {
  if (String(env.OTEL_LOGS_ENABLED).toLowerCase() !== 'true') {
    return null;
  }

  try {
    return {
      endpoint: normalizeOpenTelemetryLogsEndpoint(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || DEFAULT_OTEL_LOGS_ENDPOINT),
      headers: parseOpenTelemetryHeaders(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS || env.OTEL_EXPORTER_OTLP_HEADERS),
      serviceName: env.OTEL_SERVICE_NAME?.trim() || 'ci-os-hub',
      serviceVersion: env.OTEL_SERVICE_VERSION?.trim() || env.TIPI_VERSION?.trim(),
      logLevel: normalizeLogLevel(logLevel),
    };
  } catch {
    return null;
  }
};

export const mapOpenTelemetrySeverityNumber = (level: string) => {
  switch (normalizeLogLevel(level)) {
    case LOG_LEVEL_ENUM.debug:
      return SeverityNumber.DEBUG;
    case LOG_LEVEL_ENUM.warn:
      return SeverityNumber.WARN;
    case LOG_LEVEL_ENUM.error:
      return SeverityNumber.ERROR;
    default:
      return SeverityNumber.INFO;
  }
};

const registerOpenTelemetryShutdown = (provider: LoggerProvider) => {
  const openTelemetryGlobalState = globalThis as OpenTelemetryGlobalState;

  if (openTelemetryGlobalState.__ciOsHubOpenTelemetryShutdownRegistered) {
    return;
  }

  openTelemetryGlobalState.__ciOsHubOpenTelemetryShutdownRegistered = true;

  const shutdown = async () => {
    await provider.forceFlush();
    await provider.shutdown();
  };

  process.once('beforeExit', () => {
    void shutdown();
  });
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
};

const getOrCreateOpenTelemetryLogger = (config: OpenTelemetryLoggerConfig) => {
  const key = JSON.stringify(config);

  if (openTelemetryLoggerState?.key === key) {
    return openTelemetryLoggerState.logger;
  }

  const provider = new LoggerProvider();
  provider.addLogRecordProcessor(new BatchLogRecordProcessor(new OTLPLogExporter({ url: config.endpoint, headers: config.headers })));
  logs.setGlobalLoggerProvider(provider);

  const logger = logs.getLogger(config.serviceName, config.serviceVersion);
  registerOpenTelemetryShutdown(provider);

  openTelemetryLoggerState = { key, logger, provider };

  return logger;
};

/**
 * Given an id and a logs folder, creates a new winston logger
 *
 * @param {string} id - The id of the logger, used to identify the logger in the logs
 * @param {string} logsFolder - The folder where the logs will be stored
 */
export const newLogger = (_id: string, logsFolder: string, logLevel: LogLevel = LOG_LEVEL_ENUM.info) => {
  const tr: Transports[] = [];
  const exceptionHandlers: Transports[] = [new transports.Console()];

  try {
    tr.push(
      new transports.File({
        filename: path.join(logsFolder, 'error.log'),
        format: fileFormat,
        level: 'error',
      }),
    );
    tr.push(
      new transports.File({
        filename: path.join(logsFolder, 'app.log'),
        format: fileFormat,
        level: logLevel,
      }),
    );

    tr.push(new transports.Console({ level: logLevel, format: consoleFormat }));
  } catch (_error) {
    // no-op
  }

  return createLogger({
    level: logLevel,
    transports: tr,
    exceptionHandlers,
    exitOnError: false,
  });
};

@Injectable()
export class LoggerService {
  private winstonLogger: Logger;
  private openTelemetryLogger: OtelLogger | null = null;
  private openTelemetryLogLevel: LogLevel = LOG_LEVEL_ENUM.info;
  private openTelemetryServiceName = 'ci-os-hub';
  private openTelemetryServiceVersion?: string;

  private logsFolder: string;
  private flushInterval: NodeJS.Timeout | null = null;

  constructor(id: string, folder: string, logLevel: LogLevel) {
    this.winstonLogger = newLogger(id, folder, logLevel);
    this.logsFolder = folder;
    this.openTelemetryLogLevel = normalizeLogLevel(logLevel);

    const openTelemetryConfig = getOpenTelemetryLoggerConfig(logLevel);
    if (!openTelemetryConfig) {
      return;
    }

    try {
      this.openTelemetryLogger = getOrCreateOpenTelemetryLogger(openTelemetryConfig);
      this.openTelemetryLogLevel = openTelemetryConfig.logLevel;
      this.openTelemetryServiceName = openTelemetryConfig.serviceName;
      this.openTelemetryServiceVersion = openTelemetryConfig.serviceVersion;
    } catch (_error) {
      this.openTelemetryLogger = null;
    }
  }

  private streamLogToHistory(logFile: string) {
    const maxLines = 10_000;
    const logFilePath = path.join(this.logsFolder, logFile);
    const historyFilePath = path.join(this.logsFolder, `${logFile}.history`);
    const tempHistoryPath = `${historyFilePath}.tmp`;

    return new Promise<void>((resolve, reject) => {
      try {
        const tempHistoryWriteStream = fs.createWriteStream(tempHistoryPath);

        if (fs.existsSync(historyFilePath)) {
          const historyReadStream = fs.createReadStream(historyFilePath, 'utf-8');
          const historyLineReader = readline.createInterface({ input: historyReadStream });

          const lineBuffer: string[] = [];
          historyLineReader.on('line', (line) => {
            lineBuffer.push(line);
            if (lineBuffer.length > maxLines) {
              lineBuffer.shift();
            }
          });

          historyLineReader.on('close', () => {
            // Write the last `maxLines` lines to the temp file
            for (const line of lineBuffer) {
              tempHistoryWriteStream.write(`${line}\n`);
            }
            appendLogFile();
          });

          historyReadStream.on('error', reject);
        } else {
          appendLogFile();
        }

        function appendLogFile() {
          const logReadStream = fs.createReadStream(logFilePath, 'utf-8');
          logReadStream.pipe(tempHistoryWriteStream, { end: false });

          logReadStream.on('end', async () => {
            tempHistoryWriteStream.end();

            await fs.promises.rename(tempHistoryPath, historyFilePath);

            await fs.promises.writeFile(logFilePath, '', 'utf-8');
            resolve();
          });

          logReadStream.on('error', reject);
        }

        tempHistoryWriteStream.on('error', reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  public flush = async () => {
    try {
      if (fs.existsSync(path.join(this.logsFolder, 'app.log'))) {
        await this.streamLogToHistory('app.log');
      }
      if (fs.existsSync(path.join(this.logsFolder, 'error.log'))) {
        await this.streamLogToHistory('error.log');
      }
      this.winstonLogger.info('Logs flushed');
    } catch (error) {
      this.winstonLogger.error('Error flushing logs', error);
    }
  };

  private static readonly DAILY_MS = 24 * 60 * 60 * 1000;

  public startPeriodicFlush() {
    if (this.flushInterval) return;
    this.flushInterval = setInterval(() => {
      this.flush().catch((e) => this.winstonLogger.error('Periodic log flush failed', e));
    }, LoggerService.DAILY_MS);
  }

  public stopPeriodicFlush() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }

  private log = (level: string, messages: unknown[]) => {
    const stringMessages = messages.flatMap((m) => {
      if (m instanceof Error) {
        return [m.message, m.stack];
      }

      if (typeof m === 'object') {
        return JSON.stringify(m, null, 2);
      }

      return m;
    });

    const message = stringMessages.join(' ');

    this.winstonLogger.log(level, message);

    if (!this.openTelemetryLogger || !shouldEmitLogLevel(level, this.openTelemetryLogLevel)) {
      return;
    }

    try {
      this.openTelemetryLogger.emit({
        body: message,
        severityNumber: mapOpenTelemetrySeverityNumber(level),
        severityText: normalizeLogLevel(level).toUpperCase(),
        attributes: {
          'service.name': this.openTelemetryServiceName,
          ...(this.openTelemetryServiceVersion ? { 'service.version': this.openTelemetryServiceVersion } : {}),
        },
      });
    } catch (_error) {
      // no-op
    }
  };

  public error = (...message: unknown[]) => {
    this.log('error', message);
  };

  public info = (...message: unknown[]) => {
    this.log('info', message);
  };

  public warn = (...message: unknown[]) => {
    this.log('warn', message);
  };

  public debug = (...message: unknown[]) => {
    this.log('debug', message);
  };
}
