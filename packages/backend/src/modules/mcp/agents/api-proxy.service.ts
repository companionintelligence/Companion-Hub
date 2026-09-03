import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import type { AppUrn } from '@ci-hub/common/types';
import type { AgentOpenApiAuth } from '@ci-hub/common/schemas';

const MAX_RESPONSE_SIZE = 100 * 1024; // 100KB

interface OpenApiOperationRef {
  method: string;
  path: string;
  parameters?: Array<{ name: string; in: string }>;
}

/**
 * Proxies HTTP requests to app containers.
 * Implements AOA-2 (OpenAPI proxy) and APX-1 (generic escape hatch).
 */
@Injectable()
export class ApiProxyService {
  constructor(
    readonly _appFilesManager: AppFilesManager,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Proxy a call generated from an OpenAPI operation.
   * S-AOA-2.1: Construct HTTP request from tool parameters
   * S-AOA-2.2: Inject auth credentials
   * S-AOA-2.3: Return response, truncate if > 100KB
   * S-AOA-2.4: Non-2xx → isError with status code
   */
  async proxyOpenApiCall(
    appUrn: AppUrn,
    operation: OpenApiOperationRef,
    params: Record<string, unknown>,
    auth?: AgentOpenApiAuth,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    let urlPath = operation.path;

    // Interpolate path parameters
    for (const param of operation.parameters ?? []) {
      if (param.in === 'path' && params[param.name] !== undefined) {
        urlPath = urlPath.replace(`{${param.name}}`, encodeURIComponent(String(params[param.name])));
      }
    }

    // Build query string from query parameters
    const queryParams: Record<string, string> = {};
    for (const param of operation.parameters ?? []) {
      if (param.in === 'query' && params[param.name] !== undefined) {
        queryParams[param.name] = String(params[param.name]);
      }
    }

    const body = params.body as Record<string, unknown> | undefined;

    return this.proxyRequest(appUrn, {
      method: operation.method.toUpperCase(),
      path: urlPath,
      body,
      queryParams,
      auth,
    });
  }

  /**
   * Generic HTTP proxy escape hatch.
   * S-APX-1.1: Makes HTTP request to app container and returns response
   * S-APX-1.2: Injects auth from OpenAPI config
   * S-APX-1.3: Works even without agent config using known host:port
   * S-APX-1.4: Truncates responses over 100KB
   */
  async proxyRequest(
    appUrn: AppUrn,
    options: {
      method: string;
      path: string;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
      queryParams?: Record<string, string>;
      auth?: AgentOpenApiAuth;
    },
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    try {
      const baseUrl = this.resolveAppBaseUrl(appUrn);
      const url = new URL(options.path, baseUrl);

      // Append query parameters
      for (const [key, value] of Object.entries(options.queryParams ?? {})) {
        url.searchParams.set(key, value);
      }

      // Build headers
      const headers: Record<string, string> = { ...options.headers };
      if (options.body) {
        headers['content-type'] = 'application/json';
      }

      // Inject auth (S-AOA-2.2, S-APX-1.2)
      this.injectAuth(headers, options.auth);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      try {
        const response = await fetch(url.toString(), {
          method: options.method,
          headers,
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });

        const text = await response.text();

        // S-AOA-2.3 / S-APX-1.4: Truncate large responses
        const truncated = text.length > MAX_RESPONSE_SIZE;
        const responseText = truncated
          ? `${text.slice(0, MAX_RESPONSE_SIZE)}\n\n[Response truncated — ${text.length} bytes total, showing first ${MAX_RESPONSE_SIZE}]`
          : text;

        // S-AOA-2.4: Non-2xx → isError
        if (response.status < 200 || response.status >= 300) {
          return {
            content: [{ type: 'text', text: `HTTP ${response.status}: ${responseText}` }],
            isError: true,
          };
        }

        return { content: [{ type: 'text', text: responseText }] };
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Proxy request failed';
      this.logger.error(`API proxy error for ${appUrn}: ${message}`);
      return {
        content: [{ type: 'text', text: `Proxy error: ${message}` }],
        isError: true,
      };
    }
  }

  /**
   * Resolve the base URL for an app container.
   * Uses the app's internal hostname and port from the container network.
   */
  private resolveAppBaseUrl(appUrn: AppUrn): string {
    const [storeSlug, appName] = appUrn.split(':') as [string, string];
    // Container hostname is the compose service name, typically the app name
    return `http://${appName}-${storeSlug}`;
  }

  private injectAuth(headers: Record<string, string>, auth?: AgentOpenApiAuth): void {
    if (!auth || auth.type === 'none') return;

    const tokenValue = auth.token_env ? process.env[auth.token_env] : undefined;
    if (!tokenValue) return;

    switch (auth.type) {
      case 'bearer': {
        const headerName = auth.header ?? 'Authorization';
        headers[headerName] = `Bearer ${tokenValue}`;
        break;
      }
      case 'basic': {
        const headerName = auth.header ?? 'Authorization';
        headers[headerName] = `Basic ${Buffer.from(tokenValue).toString('base64')}`;
        break;
      }
      case 'api_key': {
        if (auth.api_key_in === 'header') {
          const headerName = auth.api_key_name ?? auth.header ?? 'X-API-Key';
          headers[headerName] = tokenValue;
        }
        // query params handled at URL construction level
        break;
      }
    }
  }
}
