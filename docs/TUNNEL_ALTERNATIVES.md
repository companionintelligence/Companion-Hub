# Tunnel Alternatives for CI-Hub

## Overview

This document reviews alternatives to Cloudflare Tunnel for exposing CI-Hub and user applications to the internet. The goal is to identify solutions that can overcome Cloudflare's tunnel limits while maintaining security, ease of use, and integration with the existing CI-Hub architecture.

## Current Implementation: Cloudflare Tunnel

### Architecture

The CI-Hub currently uses Cloudflare Tunnel (via `cloudflared`) to:
1. Expose the Hub dashboard to the internet at `hub-{device-slug}-{org-slug}.{domain}`
2. Expose user-installed applications at `{app}-{device-slug}-{org-slug}.{domain}`
3. Provide automatic TLS termination via Cloudflare's edge
4. Integrate with Cloudflare Zero Trust for access control

### Integration Points

Key files and services that implement tunnel functionality:

1. **CloudflareClientService** (`packages/backend/src/modules/cloudflare/cloudflare-client.service.ts`)
   - Initializes tunnel with credentials from CI-Portal
   - Writes tunnel token to disk at `/app/tunnel/token`
   - Starts/stops the `cloudflared` container
   - Syncs exposed apps to CI-Portal via `POST /api/tunnels/state`

2. **RegistrationService** (`packages/backend/src/modules/registration/registration.service.ts`)
   - Manages tunnel token lifecycle during device registration
   - Recovers tunnel token from database on restart
   - Ensures `cloudflared` container is running
   - Validates tunnel connectivity

3. **Docker Compose** (`docker-compose.prod.yml`)
   - Defines `cloudflared` service as an optional profile (`--profile cloudflare`)
   - Mounts tunnel directory to `/home/nonroot/.cloudflared`
   - Runs `cloudflared tunnel run --token-file`

4. **CI-Portal Integration**
   - Portal provisions Cloudflare tunnels via API
   - Portal manages DNS records (CNAME to `{tunnelId}.cfargotunnel.com`)
   - Portal configures ingress rules for each exposed app
   - Portal manages Cloudflare Zero Trust access policies

### Limitations

1. **Tunnel Limits**: Cloudflare has hard limits on the number of tunnels per account
2. **Vendor Lock-in**: Tight coupling to Cloudflare ecosystem
3. **Cost**: Advanced features require paid Cloudflare plans
4. **Privacy**: Traffic flows through Cloudflare's infrastructure
5. **Control**: Limited ability to customize routing and access control

## Alternative 1: Octelium

### What is Octelium?

Octelium is a free, open-source, self-hosted unified zero trust secure access platform that can function as:
- A modern, zero-config remote access VPN (over WireGuard/QUIC)
- A Zero Trust Network Access (ZTNA) platform
- An API/AI gateway
- A programmable secure tunnel (ngrok/Cloudflare Tunnel alternative)
- A PaaS-like environment for containerized apps

### Architecture

Octelium's architecture is based on:
- Identity-aware, application-layer (L7) secure access
- Secretless authentication
- Context/policy-based access controls
- Scalability via containers or Kubernetes

### How It Would Work for CI-Hub

#### Option A: Central Octelium Cluster (Portal-Managed)

```
┌──────────────┐         ┌──────────────────┐         ┌──────────────────┐
│  CI Hub      │         │  Octelium        │         │  End Users       │
│  (Device)    │         │  Cluster         │         │  (Browser)       │
└──────┬───────┘         └────────┬─────────┘         └────────┬─────────┘
       │                          │                            │
       │  Octelium client         │                            │
       │  connects to cluster     │                            │
       │ ────────────────────────►│                            │
       │  WireGuard/QUIC          │                            │
       │                          │                            │
       │                          │  HTTPS requests            │
       │                          │◄───────────────────────────│
       │                          │                            │
       │  Forward traffic         │                            │
       │◄─────────────────────────│                            │
       │  to Traefik              │                            │
```

**Implementation Steps:**
1. Deploy Octelium cluster on CI-Portal infrastructure
2. Generate Octelium client credentials during device registration
3. Install Octelium client as a sidecar container in Hub
4. Configure Octelium to route traffic to Traefik
5. Update CI-Portal to manage Octelium access policies instead of Cloudflare

**Pros:**
- No tunnel limits (scales with cluster resources)
- Full control over routing and access policies
- Built-in zero trust features
- No vendor lock-in
- Privacy-focused (self-hosted)
- Supports both VPN and tunnel modes

**Cons:**
- Requires hosting Octelium cluster infrastructure
- More complex initial setup
- CI-Portal would need to manage Octelium cluster
- Different access control mechanisms than Cloudflare Zero Trust
- May require custom DNS management

#### Option B: Hub-Local Octelium (Distributed)

```
┌──────────────────────────────┐         ┌──────────────────┐
│  CI Hub                      │         │  End Users       │
│                              │         │  (Browser)       │
│  ┌────────────────────────┐  │         └────────┬─────────┘
│  │  Octelium Container    │  │                  │
│  │  (local cluster)       │  │                  │
│  └───────┬────────────────┘  │                  │
│          │                   │                  │
│  ┌───────▼────────────────┐  │                  │
│  │  Traefik              │  │                  │
│  │  (local routing)      │  │                  │
│  └───────────────────────┘  │                  │
└──────────────────────────────┘                  │
       ▲                                         │
       │         HTTPS over public IP            │
       │◄────────────────────────────────────────┘
```

**Implementation Steps:**
1. Add Octelium as a container service in `docker-compose.prod.yml`
2. Configure Octelium to expose Traefik
3. Update DNS to point to Hub's public IP (via Dynamic DNS or manual)
4. Configure Octelium access policies via Hub UI

**Pros:**
- Fully distributed, no central infrastructure needed
- Each Hub manages its own tunnel
- Complete independence from CI-Portal
- Simpler portal implementation

**Cons:**
- Requires public IP or Dynamic DNS for each Hub
- Each Hub needs to manage its own Octelium instance
- More complex Hub setup
- No centralized access control

### Code Changes Required

#### 1. New TunnelService Abstraction

Create a pluggable tunnel service interface:

```typescript
// packages/backend/src/modules/tunnel/tunnel.interface.ts
export interface ITunnelService {
  initializeTunnel(credentials: TunnelCredentials): Promise<TunnelResult>;
  syncExposedApps(apps: AppInfo[]): Promise<boolean>;
  ensureTunnelRunning(): Promise<boolean>;
  getTunnelStatus(): Promise<TunnelStatus>;
}

// Implementations:
// - CloudflareTunnelService (existing)
// - OcteliumTunnelService (new)
// - TailscaleTunnelService (existing, enhanced)
```

#### 2. OcteliumClientService

Similar structure to `CloudflareClientService`:

```typescript
// packages/backend/src/modules/octelium/octelium-client.service.ts
@Injectable()
export class OcteliumClientService implements ITunnelService {
  async initializeTunnel(credentials: OcteliumCredentials): Promise<TunnelResult> {
    // Write Octelium client config
    // Start Octelium container
    // Establish connection to cluster
  }

  async syncExposedApps(apps: AppInfo[]): Promise<boolean> {
    // Update Octelium access policies
    // Configure routing rules
  }
}
```

#### 3. Portal Changes

```typescript
// CI-Portal: packages/backend/src/modules/tunnel/octelium.manager.ts
export class OcteliumManager {
  async provisionTunnel(deviceId: string, orgId: string) {
    // Generate Octelium client credentials
    // Create access policies
    // Return credentials to device
  }

  async updateRouting(deviceId: string, apps: AppInfo[]) {
    // Update Octelium cluster routing configuration
    // Manage DNS if needed
  }
}
```

#### 4. Docker Compose Updates

```yaml
# docker-compose.prod.yml
  octelium-client:
    image: octelium/client:latest
    container_name: octelium-client
    restart: unless-stopped
    cap_add:
      - NET_ADMIN
    volumes:
      - ${ROOT_FOLDER_HOST:-.internal}/octelium:/etc/octelium
    networks:
      - ci_os_hub_network
    profiles:
      - octelium
```

### Migration Path

1. **Phase 1: Add Octelium as Optional**
   - Implement OcteliumClientService
   - Add tunnel provider selection to registration flow
   - Maintain Cloudflare as default

2. **Phase 2: Parallel Operation**
   - Support both Cloudflare and Octelium simultaneously
   - Allow switching between providers
   - Gather feedback and metrics

3. **Phase 3: Gradual Migration**
   - Default new registrations to Octelium
   - Provide migration tool for existing Cloudflare users
   - Deprecation notice for Cloudflare

4. **Phase 4: Cloudflare Optional**
   - Make Cloudflare an optional legacy provider
   - Document Octelium as primary recommendation

## Alternative 2: Enhanced Tailscale (Already Integrated)

### Current Tailscale Integration

CI-Hub already has Tailscale integration via the `hub-tailscale` container:
- Provides private VPN access to the Hub network
- Advertises Docker bridge subnet to tailnet
- Allows secure remote access without public exposure

### Enhancement: Tailscale Funnel

Tailscale Funnel allows exposing services to the public internet through Tailscale infrastructure:

```typescript
// Enhanced TailscaleService with Funnel support
async enableFunnel(hostname: string, port: number): Promise<string> {
  // Configure Tailscale Funnel to expose port
  // Returns public HTTPS URL
  return `https://${hostname}.${tailscaleDomain}`;
}
```

**Pros:**
- Already integrated in CI-Hub
- Simple to enable
- Automatic HTTPS
- No tunnel limits
- Strong security model

**Cons:**
- Public URLs are on Tailscale domains (not custom)
- Requires Tailscale account for each Hub
- Less control over branding
- Different access model than current

### Code Changes Required

Relatively minimal:
1. Extend `TailscaleService` to support Funnel
2. Add Funnel configuration to Hub UI
3. Update registration to support Tailscale as tunnel provider

## Alternative 3: Hybrid Approach

### Architecture

Use multiple tunnel providers based on use case:

```
┌─────────────────────────────────────────────────────────────┐
│  CI Hub                                                      │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ Cloudflare  │  │  Octelium   │  │ Tailscale   │         │
│  │  (Legacy)   │  │  (Primary)  │  │   (VPN)     │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│         │                │                │                 │
│         └────────────────┴────────────────┘                 │
│                          │                                  │
│                   ┌──────▼───────┐                          │
│                   │   Traefik    │                          │
│                   └──────────────┘                          │
└─────────────────────────────────────────────────────────────┘
```

**Tunnel Provider Selection:**
- **Octelium**: Default for new installations, public app exposure
- **Tailscale**: Private VPN access, development/testing
- **Cloudflare**: Legacy support, existing installations

### Implementation Strategy

```typescript
// packages/backend/src/modules/tunnel/tunnel.factory.ts
@Injectable()
export class TunnelFactory {
  create(provider: TunnelProvider): ITunnelService {
    switch (provider) {
      case 'cloudflare':
        return this.moduleRef.get(CloudflareTunnelService);
      case 'octelium':
        return this.moduleRef.get(OcteliumTunnelService);
      case 'tailscale':
        return this.moduleRef.get(TailscaleTunnelService);
      default:
        throw new Error(`Unknown tunnel provider: ${provider}`);
    }
  }
}
```

## Comparison Matrix

| Feature | Cloudflare Tunnel | Octelium (Portal) | Octelium (Local) | Tailscale Funnel |
|---------|------------------|-------------------|------------------|------------------|
| **Tunnel Limits** | Yes (account-based) | No (cluster resources) | No | No |
| **Custom Domains** | Yes | Yes (with DNS mgmt) | Requires setup | Limited |
| **Zero Trust** | Built-in | Built-in | Built-in | Built-in |
| **Self-Hosted** | No | Yes | Yes | No |
| **Setup Complexity** | Low | Medium | Medium | Low |
| **Portal Changes** | Minimal (current) | Significant | Minimal | Minimal |
| **Hub Changes** | Minimal (current) | Medium | Medium | Low |
| **Cost** | SaaS fees | Infrastructure | None | SaaS fees |
| **Privacy** | Traffic via CF | Self-hosted | Self-hosted | Traffic via TS |
| **Scalability** | CF-limited | High | Per-Hub | High |
| **Maintenance** | None (managed) | Cluster maintenance | Per-Hub | None (managed) |

## Recommendations

### Short-term (3-6 months)

1. **Enhance Tailscale Integration**
   - Add Tailscale Funnel support as an optional tunnel provider
   - Lowest effort, immediate relief from tunnel limits
   - Good for users comfortable with Tailscale branding

2. **Abstract Tunnel Service**
   - Implement `ITunnelService` interface
   - Refactor CloudflareClientService to use interface
   - Prepare for multiple tunnel providers

### Medium-term (6-12 months)

3. **Octelium POC**
   - Deploy experimental Octelium cluster
   - Implement OcteliumClientService
   - Test with beta users
   - Gather feedback on stability and performance

4. **Portal-Managed Octelium**
   - Full implementation of Octelium integration in CI-Portal
   - DNS management automation
   - Access policy management UI

### Long-term (12+ months)

5. **Hybrid Deployment**
   - Support multiple tunnel providers simultaneously
   - User choice during registration
   - Migration tools for switching providers
   - Default to Octelium for new installations

6. **Deprecate Cloudflare (Optional)**
   - Evaluate if Cloudflare should remain as legacy option
   - Communicate deprecation timeline if needed
   - Provide clear migration path

## Technical Considerations

### DNS Management

Different approaches for DNS:
- **Cloudflare**: Managed via API (current)
- **Octelium**: Requires custom DNS solution (Cloudflare API, Route53, etc.)
- **Tailscale**: Uses Tailscale domains (no custom DNS)

Recommendation: Implement pluggable DNS manager similar to tunnel abstraction.

### Access Control

- **Cloudflare**: Zero Trust with Portal as OIDC IdP
- **Octelium**: Built-in access policies, SSO integration
- **Tailscale**: Tailnet membership, ACLs

Recommendation: Map Portal organizations to tunnel provider access policies.

### TLS Certificates

- **Cloudflare**: Automatic via Cloudflare edge
- **Octelium**: Built-in ACME, custom certs
- **Tailscale**: Automatic via Tailscale

All options provide automatic HTTPS.

### Monitoring and Observability

Need to implement:
- Tunnel health checks
- Connection status monitoring
- Traffic metrics
- Failover detection

## Migration Planning

### For Existing Cloudflare Users

1. **Assessment Phase**
   - Identify all registered devices
   - Document current tunnel configuration
   - Test new provider with subset of devices

2. **Preparation**
   - Deploy new tunnel infrastructure
   - Create migration documentation
   - Build automated migration tools

3. **Migration**
   - Gradual rollout by organization
   - Maintain Cloudflare during transition
   - Monitor for issues

4. **Cleanup**
   - Decommission Cloudflare tunnels
   - Update documentation
   - Remove Cloudflare-specific code (if fully migrating)

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Octelium cluster downtime | High | Multi-region deployment, monitoring, fallback to Cloudflare |
| DNS propagation delays | Medium | TTL management, status page, user communication |
| Increased maintenance burden | Medium | Automation, monitoring, documentation |
| User confusion with multiple options | Low | Clear defaults, guided setup, documentation |
| Migration failures | High | Thorough testing, rollback procedures, staged rollout |

## Conclusion

**Recommended Path Forward:**

1. **Immediate**: Implement tunnel service abstraction to prepare for multiple providers
2. **Next Quarter**: Add Tailscale Funnel as a quick alternative to Cloudflare
3. **Following Quarter**: Deploy and test Octelium cluster with beta users
4. **Long-term**: Make Octelium the default, maintain Cloudflare and Tailscale as options

This approach provides:
- **Immediate relief** from tunnel limits via Tailscale
- **Long-term solution** via self-hosted Octelium
- **Flexibility** for users to choose based on needs
- **Gradual migration** minimizing disruption
- **Fallback options** for reliability

The hybrid approach leverages the strengths of each provider while maintaining the flexibility to adapt as requirements evolve.
