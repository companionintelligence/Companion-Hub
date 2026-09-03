import fs from 'node:fs';
import https from 'node:https';
import type { AxiosRequestConfig } from 'axios';

/** Optional server-side override when CI_CLOUD_URL is browser-facing (e.g. https://ci-portal.localhost). */
export function readPortalInternalUrlOverride(): string | undefined {
  const value = process.env.CI_PORTAL_INTERNAL_URL?.trim();
  return value || undefined;
}

export function isDockerContainer(): boolean {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

export function isLoopbackPortalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]' || normalized.endsWith('.localhost');
}

export function needsDockerHostBridge(publicCiCloudUrl: string, internalOverride?: string): boolean {
  if (internalOverride) {
    return false;
  }
  if (!isDockerContainer()) {
    return false;
  }

  try {
    return isLoopbackPortalHost(new URL(publicCiCloudUrl.trim()).hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve the Portal base URL for server-side outbound calls from the Hub backend.
 *
 * Browser-facing URLs like https://ci-portal.localhost work on the host but not
 * from inside Docker (loopback resolves to the container). When running in Docker,
 * loopback Portal URLs are bridged through host.docker.internal while preserving
 * the public hostname for TLS SNI.
 */
export function resolveOutboundPortalBaseUrl(publicCiCloudUrl: string, internalOverride?: string): string {
  const override = internalOverride?.trim().replace(/\/+$/, '');
  if (override) {
    return override;
  }

  const trimmed = publicCiCloudUrl.trim().replace(/\/+$/, '');
  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  if (!needsDockerHostBridge(trimmed, internalOverride)) {
    return trimmed;
  }

  const bridged = new URL(parsed.toString());
  bridged.hostname = 'host.docker.internal';
  if (!parsed.port) {
    bridged.port = parsed.protocol === 'https:' ? '443' : '80';
  }

  return bridged.toString().replace(/\/+$/, '');
}

/** TLS servername for bridged HTTPS calls (Caddy serves *.localhost certs). */
export function resolvePortalTlsServername(publicCiCloudUrl: string): string | undefined {
  try {
    const hostname = new URL(publicCiCloudUrl.trim()).hostname;
    return isLoopbackPortalHost(hostname) ? hostname : undefined;
  } catch {
    return undefined;
  }
}

function allowInsecureLocalPortalTls(publicCiCloudUrl: string, internalOverride?: string): boolean {
  if (process.env.NODE_ENV === 'production') {
    return false;
  }
  return needsDockerHostBridge(publicCiCloudUrl, internalOverride);
}

export function createPortalHttpsAgent(publicCiCloudUrl: string, internalOverride?: string): https.Agent | undefined {
  const servername = resolvePortalTlsServername(publicCiCloudUrl);
  if (!servername) {
    return undefined;
  }

  try {
    const outbound = resolveOutboundPortalBaseUrl(publicCiCloudUrl, internalOverride);
    if (new URL(outbound).protocol !== 'https:') {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return new https.Agent({
    servername,
    rejectUnauthorized: !allowInsecureLocalPortalTls(publicCiCloudUrl, internalOverride),
  });
}

function resolvePortalHostHeader(publicCiCloudUrl: string, internalOverride?: string): string | undefined {
  if (!needsDockerHostBridge(publicCiCloudUrl, internalOverride)) {
    return undefined;
  }

  try {
    return new URL(publicCiCloudUrl.trim()).host;
  } catch {
    return undefined;
  }
}

export function buildPortalAxiosConfig(publicCiCloudUrl: string, internalOverride?: string): AxiosRequestConfig {
  const httpsAgent = createPortalHttpsAgent(publicCiCloudUrl, internalOverride);
  const host = resolvePortalHostHeader(publicCiCloudUrl, internalOverride);
  return {
    ...(httpsAgent ? { httpsAgent } : {}),
    ...(host ? { headers: { Host: host } } : {}),
  };
}

function normalizeAxiosHeaders(headers: AxiosRequestConfig['headers']): Record<string, string> {
  if (!headers) {
    return {};
  }

  const maybeJson = headers as { toJSON?: () => unknown };
  if (typeof maybeJson.toJSON === 'function') {
    const json = maybeJson.toJSON();
    return json && typeof json === 'object' ? (json as Record<string, string>) : {};
  }

  return headers as Record<string, string>;
}

export function withPortalAxiosHeaders(config: AxiosRequestConfig, headers: Record<string, string>): AxiosRequestConfig {
  return {
    ...config,
    headers: {
      ...normalizeAxiosHeaders(config.headers),
      ...headers,
    },
  };
}
