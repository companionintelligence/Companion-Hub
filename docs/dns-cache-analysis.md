# DNS cache analysis: `DNS_PROBE_FINISHED_NXDOMAIN`

## Problem statement

When you select **Open** in the Companion Hub desktop app to launch a newly created public domain, the browser shows `DNS_PROBE_FINISHED_NXDOMAIN`. Opening the same URL manually in the browser works.

## Root cause

### Why this happens

The issue comes from a difference between the system DNS cache and the browser DNS cache, rather than from DNS propagation:

1. **Tauri's `openUrl()` flow:**
   - `@tauri-apps/plugin-opener` → Rust backend → System shell → Default browser launch
   - This path uses the **OS-level DNS resolver** (not the browser's DNS cache)

2. **Manual browser navigation:**
   - Browser → Browser's internal DNS cache/DoH/resolver
   - Modern browsers (Chrome/Firefox) often use their own DNS resolution (DoH, browser cache)

3. **Timing before the fix:**
   ```
   Time 0: App creates new DNS record via Cloudflare API
   Time 1: App immediately calls openUrl(newDomain) 
   Time 2: System DNS resolver queries (cache miss) → upstream DNS
   Time 3: Browser launches with stale system DNS resolution
   ```

4. **Flow after the fix:**
   ```
   Time 0: App creates new DNS record via Cloudflare API
   Time 1: App flushes system DNS cache
   Time 2: App pre-warms DNS via fetch() HEAD request
   Time 3: System and browser DNS caches now populated
   Time 4: openUrl(newDomain) → Browser launches successfully
   ```

### Key differences

| Aspect | Tauri `openUrl()` | Manual browser navigation |
|--------|------------------|---------------------|
| DNS resolver | System (`systemd-resolved`, `dnsmasq`, etc.) | Browser (DoH, internal cache) |
| Cache TTL | System-wide (often 60s+) | Browser-controlled (can be 0s) |
| Resolution path | OS → ISP or configured DNS | Browser → DoH provider (1.1.1.1, 8.8.8.8) |
| Refresh trigger | System TTL expiry | Browser refresh or new tab |

## Evidence in code before the fix

### URL construction (`app-access-points.tsx:68-108`)
```typescript
const derivedPublicIdentity = !configuredPublicDomain && cleanSubdomain && resolvedPublicDomain
  ? buildPublicWebIdentity({
      appSubdomain: cleanSubdomain,
      hubSubdomain: deviceSlug ? `hub-${deviceSlug}${organizationSlug ? `-${organizationSlug}` : ''}` : undefined,
      orgSlug: organizationSlug,
      publicDomainRoot: resolvedPublicDomain,
    })
  : null;

const publicHost = configuredPublicDomain || derivedPublicIdentity?.hostname || null;
const publicUrl = publicHost ? buildHttpsUrl(publicHost, sslPort, urlSuffix) : null;
```
- The code constructs the URL correctly.
- Before the fix, the code didn't warm or verify DNS before opening the URL.

### Launch mechanism (`open-external.ts:19-29`, original)
```typescript
if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(normalizedUrl);  // ← Delegates to system shell
}
```
- Before the fix, the code didn't check DNS.
- Before the fix, the code didn't retry.
- The code relied entirely on system DNS resolution.

After the fix, the code flushes and warms the DNS cache before it calls `openUrl()`.

### Tauri opener plugin (`Cargo.toml:27`)
```toml
tauri-plugin-opener = "2"
```
- This plugin calls the system's default URL handler, such as `xdg-open`, `start`, or `open`.
- The system handler uses the **system DNS resolver**, not browser DNS.

## Why manual navigation works

When you paste the URL into your browser:
1. The browser might use **DNS over HTTPS**, which bypasses the system cache.
2. The browser's DNS cache TTL is often **shorter**.
3. The browser can **fall back to multiple resolvers**.
4. A new tab or browser refresh can clear stale entries.

## Solutions ranked by impact

### DNS prewarming (recommended)

Add a DNS verification step before you open URLs.

```typescript
// packages/frontend/src/lib/helpers/open-external.ts

async function verifyDnsResolution(hostname: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    // Use a lightweight HEAD request to trigger DNS resolution
    const response = await fetch(`https://${hostname}`, {
      method: 'HEAD',
      signal: controller.signal,
      cache: 'no-store'
    });
    
    clearTimeout(timeoutId);
    return response.ok || response.status < 500; // 4xx is OK (DNS resolved)
  } catch (err) {
    return false;
  }
}

export const openExternal = async (url: string): Promise<void> => {
  const normalizedUrl = normalizeExternalUrl(url);
  
  // Extract hostname for DNS check
  const hostname = new URL(normalizedUrl).hostname;
  
  // Pre-warm DNS before opening
  const dnsResolved = await verifyDnsResolution(hostname);
  
  if (!dnsResolved) {
    // Fallback: open in browser anyway (browser DNS may work)
    console.warn(`DNS not yet resolved for ${hostname}, opening anyway`);
  }
  
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(normalizedUrl);
      return;
    } catch {
      // Fall through
    }
  }
  window.open(normalizedUrl, '_blank', 'noopener,noreferrer');
};
```

**Advantages:**
- Warms the system DNS cache through `fetch`.
- Works across platforms.
- Opens the URL even when DNS is pending.
- Requires a small code change.

**Limitations:**
- Adds 100–500 ms of latency to the **Open** action.
- Requires a network call before launch.

### Add retry logic with a notification

Provide feedback and a retry option.

```typescript
export const openExternalWithRetry = async (url: string, maxRetries = 2): Promise<void> => {
  const normalizedUrl = normalizeExternalUrl(url);
  const hostname = new URL(normalizedUrl).hostname;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resolved = await verifyDnsResolution(hostname, 2000);
    
    if (resolved || attempt === maxRetries) {
      // Open on success or final attempt
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(normalizedUrl);
        return;
      }
      window.open(normalizedUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    
    // Wait before retry
    await new Promise(resolve => setTimeout(resolve, 1000));
    toast.info(`Waiting for DNS propagation... (${attempt + 1}/${maxRetries})`);
  }
};
```

**Advantages:**
- Handles transient DNS issues.
- Explains the delay to the user.

**Limitations:**
- Adds UI complexity.
- Can delay the action by 3–5 seconds.

### Verify Cloudflare DNS before exposure

Wait for DNS to propagate before showing the **Open** button.

Modify `packages/backend/src/modules/cloudflare/cloudflare-hostname.service.ts`:

```typescript
async function waitForDnsPropagation(hostname: string, maxWaitMs = 10000): Promise<boolean> {
  const start = Date.now();
  
  while (Date.now() - start < maxWaitMs) {
    try {
      const lookup = await dns.promises.resolve4(hostname);
      if (lookup.length > 0) return true;
    } catch {
      // Not yet propagated
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

// In exposeApp():
await cfClient.createCustomHostname(hostname, originServer);
await waitForDnsPropagation(hostname); // ← Add this
```

**Advantages:**
- Verifies DNS before the user sees the URL.
- Avoids a delay after the button appears.

**Limitations:**
- Slows the app installation and exposure flow.
- Doesn't clear a stale system cache, even if Cloudflare propagation is complete.

### Flush the system DNS cache with a Tauri command

Add a Rust command that flushes the OS DNS cache before opening the URL.

```rust
// packages/desktop/src-tauri/src/commands/dns.rs
#[tauri::command]
pub async fn flush_dns_cache() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("ipconfig")
            .arg("/flushdns")
            .output()
            .map_err(|e| e.to_string())?;
    }
    
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("dscacheutil")
            .arg("-flushcache")
            .output()
            .map_err(|e| e.to_string())?;
        
        std::process::Command::new("killall")
            .arg("-HUP")
            .arg("mDNSResponder")
            .output()
            .map_err(|e| e.to_string())?;
    }
    
    #[cfg(target_os = "linux")]
    {
        // systemd-resolved
        std::process::Command::new("systemd-resolve")
            .arg("--flush-caches")
            .output()
            .ok(); // Best effort
        
        // nscd
        std::process::Command::new("nscd")
            .arg("-i")
            .arg("hosts")
            .output()
            .ok();
    }
    
    Ok(())
}
```

```typescript
// packages/frontend/src/lib/helpers/open-external.ts
import { invoke } from '@tauri-apps/api/core';

export const openExternal = async (url: string): Promise<void> => {
  const normalizedUrl = normalizeExternalUrl(url);
  
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      // Flush system DNS cache before opening
      await invoke('flush_dns_cache').catch(() => {}); // Ignore errors
      
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(normalizedUrl);
      return;
    } catch {
      // Fall through
    }
  }
  window.open(normalizedUrl, '_blank', 'noopener,noreferrer');
};
```

**Advantages:**
- Directly addresses the system DNS cache.
- Usually takes 10–50 ms.

**Limitations:**
- Requires elevated permissions on some systems.
- Can fail silently on restricted systems.
- Adds platform-specific code.

## Recommendation

Use DNS prewarming with an optional system cache flush.

**Implementation plan:**
1. Add a `verifyDnsResolution()` helper that prewarms DNS through `fetch`.
2. Add an optional, best-effort `flush_dns_cache` Tauri command.
3. Combine both in `openExternal()`:
   ```typescript
   await invoke('flush_dns_cache').catch(() => {});
   await verifyDnsResolution(hostname);
   await openUrl(normalizedUrl);
   ```

**Why use both:**
- Covers system-level cache flushing and application-level prewarming.
- Continues to prewarm DNS if the cache flush fails.
- Works across platforms.
- Adds less than 500 ms of delay.

## Test plan

1. Create a DNS record through Cloudflare.
2. Immediately select **Open** in the Tauri app.
3. Verify that the browser opens without an NXDOMAIN error.
4. Test on Linux (`systemd-resolved`), macOS (`mDNSResponder`), and Windows (DNS Client).
5. Test these edge cases:
   - In offline mode, verify that the DNS check times out.
   - For invalid domains, verify that the browser still opens and handles the error.
   - With slow DNS servers, verify that the request doesn't block indefinitely.

## Additional notes

- **Tauri DNS APIs:** Tauri v2 doesn't expose low-level DNS control.
- **Manual browser behavior:** Browsers often use DNS over HTTPS, which bypasses the system cache, and invalidate their caches more aggressively.
- **Cloudflare propagation:** Propagation typically takes less than 5 seconds globally, but system caches can hold stale data for more than 60 seconds.
