import type { CloudProviderConfig, CloudProviderStatus } from '@ci-hub/common/types';
import { isSameServer } from './engine-credential-scope';

/**
 * A provider as `GET /api/inference/cloud-providers` and the MCP tool `hub_get_cloud_providers` report
 * it. The key is never sent, only whether there is one. The base URL is sent only when it names
 * another server than `defaultBaseUrl`, by `isSameServer`, so `/v1/` and a default port do not count.
 * Any signed-in member can read this route, so only the URL's address and path are reported. Nothing
 * written before the host or after the path is shown, since a secret can sit there.
 */
export function cloudProviderStatus(config: CloudProviderConfig, defaultBaseUrl: string): CloudProviderStatus {
  const status: CloudProviderStatus = {
    provider: config.provider,
    enabled: config.enabled,
    configured: !!config.apiKey,
    defaultModel: config.defaultModel,
  };
  if (config.baseUrl && !isSameServer(config.baseUrl, defaultBaseUrl)) {
    status.baseUrl = withoutSecretParts(config.baseUrl);
  }
  return status;
}

function withoutSecretParts(url: string): string {
  const text = url.trim();
  let parsed: URL | undefined;
  try {
    parsed = new URL(text);
  } catch {
    parsed = undefined;
  }
  // `user:password@host` parses with `user:` as its scheme, so only http and https are read as URLs.
  // Anything else is not a URL requests could reach, but it may still hold `user:password@` or `?key=`.
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return text.replace(/^([^/]*\/\/)?[^/]*@/, '$1').replace(/[?#].*$/, '');
  }
  if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) return url;
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}
