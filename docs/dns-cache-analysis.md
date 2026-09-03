# DNS Cache Issue Analysis: `DNS_PROBE_FINISHED_NXDOMAIN`

## Problem Statement
When clicking "Open" button in the CI-Hub Tauri app to launch a newly created public domain, the browser shows `DNS_PROBE_FINISHED_NXDOMAIN` error. However, manually opening the same URL in the browser works correctly.

## Root Cause Analysis

### Why This Happens

The issue is **NOT a propagation problem** but rather a **system-level DNS cache vs. browser DNS cache** discrepancy:

1. **Tauri's `openUrl()` flow**:
   - `@tauri-apps/plugin-opener` → Rust backend → System shell → Default browser launch
   - This path uses the **OS-level DNS resolver** (not the browser's DNS cache)

2. **Manual browser navigation**:
   - Browser → Browser's internal DNS cache/DoH/resolver
   - Modern browsers (Chrome/Firefox) often use their own DNS resolution (DoH, browser cache)

3. **The timing issue (pre-fix)**:
   ```
   Time 0: App creates new DNS record via Cloudflare API
   Time 1: App immediately calls openUrl(newDomain) 
   Time 2: System DNS resolver queries (cache miss) → upstream DNS
   Time 3: Browser launches with stale system DNS resolution
   ```

4. **The fix (post-fix)**:
   ```
   Time 0: App creates new DNS record via Cloudflare API
   Time 1: App flushes system DNS cache
   Time 2: App pre-warms DNS via fetch() HEAD request
   Time 3: System + browser DNS caches now populated
   Time 4: openUrl(newDomain) → Browser launches successfully
   ```

### Key Differences

| Aspect | Tauri `openUrl()` | Manual Browser Entry |
|--------|------------------|---------------------|
| DNS Resolver | System (`systemd-resolved`, `dnsmasq`, etc.) | Browser (DoH, internal cache) |
| Cache TTL | System-wide (often 60s+) | Browser-controlled (can be 0s) |
| Resolution Path | OS → ISP/configured DNS | Browser → DoH provider (1.1.1.1, 8.8.8.8) |
| Refresh Trigger | System TTL expiry | Browser refresh, new tab |

## Evidence in Code (Pre-Fix Behavior)

### 1. URL Construction (`app-access-points.tsx:68-108`)
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
- ✅ URL is constructed correctly
- ❌ **[Pre-fix]** No DNS warmup or verification before opening

### 2. Launch Mechanism (`open-external.ts:19-29` - original)
```typescript
if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(normalizedUrl);  // ← Delegates to system shell
}
```
- ❌ **[Pre-fix]** No DNS pre-check
- ❌ **[Pre-fix]** No retry logic
- ❌ **[Pre-fix]** Relies entirely on system DNS resolution

**[Post-fix]** This PR now implements DNS cache flush + warmup before calling `openUrl()`.

### 3. Tauri Opener Plugin (`Cargo.toml:27`)
```toml
tauri-plugin-opener = "2"
```
- This plugin calls the system's default URL handler (e.g., `xdg-open`, `start`, `open`)
- System handler uses **system DNS resolver**, not browser DNS

## Why It Works Manually

When you paste the URL into your browser:
1. Browser may use **DNS-over-HTTPS** (bypasses system cache)
2. Browser's DNS cache TTL is often **much shorter**
3. Browser can **fallback to multiple resolvers**
4. Recent browser tab/refresh clears stale entries

## Solutions (Ranked by Impact)

### Solution 1: DNS Pre-Warm (Recommended) ⭐
**Add a DNS verification step before opening URLs**

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

**Pros:**
- ✅ Warms system DNS cache via fetch
- ✅ Works cross-platform
- ✅ Non-blocking (user sees URL open even if DNS pending)
- ✅ Minimal code change

**Cons:**
- ⚠️ Adds 100-500ms latency to "Open" button
- ⚠️ Requires network call before launch

### Solution 2: Add Retry Logic with Toast
**Provide user feedback and retry option**

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

**Pros:**
- ✅ Handles transient DNS issues
- ✅ User-friendly feedback

**Cons:**
- ⚠️ Adds UI complexity
- ⚠️ Slower UX (3-5s delay possible)

### Solution 3: Cloudflare DNS Verification Before Exposing
**Wait for DNS to propagate before showing "Open" button**

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

**Pros:**
- ✅ Guarantees DNS is ready before user sees URL
- ✅ Zero UX friction once button appears

**Cons:**
- ❌ Slows down app installation/exposure flow
- ❌ Cloudflare propagation can be instant but system cache still stale

### Solution 4: Force System DNS Flush (Tauri Command)
**Add a Rust command to flush OS DNS cache before opening**

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

**Pros:**
- ✅ Directly solves system DNS cache issue
- ✅ Fast (10-50ms)

**Cons:**
- ❌ Requires elevated permissions on some systems
- ❌ May fail silently on restricted systems
- ❌ Platform-specific code complexity

## Recommendation

**Implement Solution 1 (DNS Pre-Warm) + Solution 4 (Optional Flush)**

**Implementation Plan:**
1. Add `verifyDnsResolution()` helper to pre-warm DNS via fetch
2. Add optional `flush_dns_cache` Tauri command (best-effort)
3. Combine both in `openExternal()`:
   ```typescript
   await invoke('flush_dns_cache').catch(() => {});
   await verifyDnsResolution(hostname);
   await openUrl(normalizedUrl);
   ```

**Why This Combo:**
- ✅ Covers both system-level (flush) and application-level (pre-warm) caching
- ✅ Graceful degradation (if flush fails, pre-warm still helps)
- ✅ Cross-platform compatible
- ✅ Minimal UX impact (<500ms delay)

## Testing Plan

1. **Create fresh DNS record** via Cloudflare
2. **Immediately click "Open"** in Tauri app
3. **Verify**: Browser opens correctly (no NXDOMAIN)
4. **Test on all platforms**: Linux (systemd-resolved), macOS (mDNSResponder), Windows (DNS Client)
5. **Test edge cases**:
   - Offline mode (DNS check should timeout gracefully)
   - Invalid domains (should open browser anyway, let browser handle)
   - Slow DNS servers (should not block indefinitely)

## Additional Notes

- **Why not use Tauri's built-in DNS APIs?** Tauri v2 doesn't expose low-level DNS control
- **Why browsers work manually?** They often use DNS-over-HTTPS (bypasses system cache) and aggressive cache invalidation
- **Cloudflare propagation**: Typically <5 seconds globally, but system caches can hold stale data for 60s+
