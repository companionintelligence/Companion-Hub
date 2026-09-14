import { Injectable } from '@nestjs/common';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import type { LifecycleActor } from '@/core/portal/lifecycle-actor';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import type { AppUrn } from '@ci-hub/common/types';
import type { AgentOpenApiAuth } from '@ci-hub/common/schemas';
import { appApiAction } from '../http-method-access';

const MAX_RESPONSE_SIZE = 100 * 1024; // 100KB

/**
 * What an app name or store slug may carry into the host a request is sent to. The Hub runs each app as
 * the compose project `<app>_<store>`, and Compose accepts only lowercase letters, digits, `_` and `-`
 * there, so no app that can run is left out. `castAppUrn` admits more — `?`, `#`, `@`, `.` — and any of
 * those pasted into a URL moves the request to a host the actor gate never asked about.
 */
const APP_HOST_SEGMENT = /^[a-z0-9_][a-z0-9_-]*$/;

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
    private readonly appLifecycle: AppLifecycleService,
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
    actor: LifecycleActor,
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
      actor,
    });
  }

  /**
   * Generic HTTP proxy escape hatch.
   * S-APX-1.1: Makes HTTP request to app container and returns response
   * S-APX-1.2: Injects auth from OpenAPI config
   * S-APX-1.3: Works even without agent config using known host:port
   * S-APX-1.4: Truncates responses over 100KB
   *
   * ⚠ THE APP ANSWERS AS IT WOULD ANSWER THE HUB. The request carries the credential the app's agent
   * config points the Hub at, so whoever reaches this reads or changes that app's data with the Hub's
   * access. It asked nothing of the caller beyond a key's capability, so a key reached every app's
   * API; it now asks the lifecycle's actor gate — `view` to read, `configure` for anything else —
   * before the request leaves the Hub (CI-Hub#1397), and sends it only to that app's host. The check is
   * marked as an app call, which a managed app key may make on any app, with any method: calling an
   * app is operating it.
   *
   * `auth` may be a lookup instead of the value, so a caller that must read the app to find it reads
   * nothing for a request the gate refuses.
   */
  async proxyRequest(
    appUrn: AppUrn,
    options: {
      method: string;
      path: string;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
      queryParams?: Record<string, string>;
      auth?: AgentOpenApiAuth | (() => Promise<AgentOpenApiAuth | undefined>);
      actor: LifecycleActor;
    },
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    // Outside the try below, which hands every failure back as a proxy error: a refusal is not one.
    // Decided from the whole request, not its method alone — an override header or `_method` can make
    // a GET run as something else (`isReadOnlyHttpRequest`).
    await this.appLifecycle.assertActorMay(options.actor, appUrn, appApiAction(options), { appCall: true });

    try {
      const baseUrl = this.resolveAppBaseUrl(appUrn);
      const url = new URL(options.path, baseUrl);

      /*
       * ⚠ `path` IS CALLER INPUT, AND A URL CAN REPLACE THE HOST. An absolute URL, or a `//host`,
       * `\\host` or `/\host` path, resolves to another origin — another app's container, a Hub service,
       * an outside host — and would carry this app's credential there, past a gate that asked only
       * about this app.
       */
      if (url.origin !== baseUrl.origin) {
        return {
          content: [{ type: 'text', text: `Proxy error: path must be a path on ${appUrn}'s API, not a URL to another host` }],
          isError: true,
        };
      }

      // Append query parameters
      for (const [key, value] of Object.entries(options.queryParams ?? {})) {
        url.searchParams.set(key, value);
      }

      // Build headers
      const headers: Record<string, string> = { ...options.headers };
      if (options.body) {
        headers['content-type'] = 'application/json';
      }

      // Inject auth (S-AOA-2.2, S-APX-1.2), looked up only now that the caller is admitted.
      const auth = typeof options.auth === 'function' ? await options.auth() : options.auth;
      this.injectAuth(headers, auth);

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
   * Resolve the base URL for an app container: `<store>-<app>`, from the URN's segments, which are
   * refused unless they can only ever name a host.
   */
  private resolveAppBaseUrl(appUrn: AppUrn): URL {
    const { appName, appStoreId } = extractAppUrn(appUrn);

    if (!APP_HOST_SEGMENT.test(appName) || !APP_HOST_SEGMENT.test(appStoreId)) {
      throw new Error(`${appUrn} is not an app the proxy can address`);
    }

    return new URL(`http://${appStoreId}-${appName}`);
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
