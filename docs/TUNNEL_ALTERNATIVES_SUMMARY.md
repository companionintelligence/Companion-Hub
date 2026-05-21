# Tunnel Alternatives: Executive Summary

## Problem Statement

Cloudflare Tunnel has hard-set limits on the number of tunnels per account, which constrains CI-Hub's ability to scale. We need alternative tunnel solutions that can overcome these limits while maintaining security, ease of use, and integration with CI-Hub's architecture.

## Current State

CI-Hub uses Cloudflare Tunnel (`cloudflared`) to:
- Expose Hub dashboard: `hub-{device}-{org}.{domain}`
- Expose user apps: `{app}-{device}-{org}.{domain}`
- Provide automatic TLS via Cloudflare edge
- Integrate with Cloudflare Zero Trust for access control

**Key limitation**: Hard tunnel limits per Cloudflare account

## Recommended Solution: Phased Hybrid Approach

### Phase 1: Tunnel Abstraction (Immediate - 1-2 months)
**Effort**: Medium | **Impact**: High (enables future flexibility)

- Create `ITunnelService` interface to decouple tunnel logic
- Refactor existing CloudflareClientService to implement interface
- No user-facing changes, architectural foundation for alternatives

### Phase 2: Add Tailscale Funnel (Short-term - 2-3 months)
**Effort**: Low | **Impact**: Medium (quick relief from limits)

- Extend existing Tailscale integration to support Funnel mode
- Provide as optional tunnel provider during registration
- Pros: Already integrated, simple to enable, no tunnel limits
- Cons: Uses Tailscale domains (not custom), different branding

### Phase 3: Octelium POC (Medium-term - 4-6 months)
**Effort**: High | **Impact**: High (long-term solution)

- Deploy experimental Octelium cluster on CI-Portal infrastructure
- Implement OcteliumTunnelService
- Beta testing with select organizations
- Pros: No limits, self-hosted, full control, zero trust built-in
- Cons: Requires cluster management, initial complexity

### Phase 4: Production Octelium (Long-term - 6-12 months)
**Effort**: High | **Impact**: Very High (primary solution)

- Make Octelium default for new installations
- Provide migration tools for existing Cloudflare users
- Maintain Cloudflare and Tailscale as legacy/alternative options
- Full DNS management and access policy automation

## Alternative Options Comparison

### Option 1: Octelium (Portal-Managed Cluster)
✅ **Recommended for long-term**

**Architecture**: Central Octelium cluster managed by CI-Portal, Hub clients connect via WireGuard/QUIC

**Pros**:
- No tunnel limits (scales with cluster resources)
- Full control over routing and access policies
- Built-in zero trust features
- Self-hosted, privacy-focused
- No vendor lock-in

**Cons**:
- Requires hosting Octelium cluster infrastructure
- CI-Portal needs cluster management capabilities
- More complex initial setup
- Custom DNS management needed

**Estimated Effort**: 3-4 months (cluster setup, client integration, portal management)

### Option 2: Tailscale Funnel (Enhanced Existing)
✅ **Recommended for short-term**

**Architecture**: Extend existing hub-tailscale container to enable Funnel for public exposure

**Pros**:
- Already integrated in CI-Hub
- Simple to enable
- Automatic HTTPS
- No tunnel limits
- Strong security model

**Cons**:
- Public URLs use Tailscale domains (`*.ts.net`)
- Requires Tailscale account per Hub
- Less control over branding
- Different access model

**Estimated Effort**: 2-4 weeks (service extension, UI updates)

### Option 3: Octelium (Hub-Local Distributed)
⚠️ **Not Recommended** (increases Hub complexity)

**Architecture**: Each Hub runs its own Octelium cluster locally

**Pros**:
- Fully distributed
- No central infrastructure
- Complete independence

**Cons**:
- Requires public IP or Dynamic DNS per Hub
- Each Hub manages own Octelium instance
- No centralized access control
- Higher maintenance burden

### Option 4: Keep Cloudflare Only
❌ **Not Viable** (doesn't solve the problem)

The tunnel limits remain a blocking issue for scale.

## Technical Implementation

### Key Code Changes Required

1. **Tunnel Service Interface** (`packages/backend/src/modules/tunnel/`)
   ```typescript
   export interface ITunnelService {
     initializeTunnel(credentials: TunnelCredentials): Promise<TunnelResult>;
     syncExposedApps(apps: AppInfo[]): Promise<boolean>;
     ensureTunnelRunning(): Promise<boolean>;
     getTunnelStatus(): Promise<TunnelStatus>;
     disconnectTunnel(): Promise<boolean>;
     getProvider(): TunnelProvider;
   }
   ```

2. **Provider Implementations**
   - `CloudflareTunnelService` (refactor existing)
   - `OcteliumTunnelService` (new)
   - `TailscaleTunnelService` (enhance existing)

3. **Factory Pattern** for provider selection
   ```typescript
   tunnelFactory.create(provider) // returns ITunnelService
   ```

4. **Docker Compose Updates**
   - Add `octelium-client` service with `octelium` profile
   - Update `hub-tailscale` configuration for Funnel support

5. **Registration Flow Changes**
   - Add tunnel provider selection UI
   - Store provider preference in device registration
   - Handle provider-specific credential formats

### CI-Portal Changes

1. **Octelium Cluster Management**
   - Deploy and monitor Octelium cluster
   - Generate client credentials during device pairing
   - Manage access policies via Octelium API

2. **Abstracted Tunnel Provisioning**
   ```typescript
   interface ITunnelProvisioner {
     createTunnel(deviceId: string, provider: TunnelProvider): Promise<Credentials>;
     updateRouting(deviceId: string, apps: AppInfo[]): Promise<boolean>;
     deleteTunnel(deviceId: string): Promise<boolean>;
   }
   ```

3. **DNS Management**
   - Implement pluggable DNS provider (Cloudflare API, Route53, etc.)
   - Handle provider-specific domain formats

## Migration Strategy

### For New Installations
- Default to Tailscale Funnel initially (Phase 2)
- Transition to Octelium as default when stable (Phase 4)
- Offer choice during registration

### For Existing Cloudflare Users
1. **Communication**: Announce timeline, benefits, migration path
2. **Opt-in Beta**: Allow early adopters to test new providers
3. **Gradual Migration**: Organization-by-organization rollout
4. **Parallel Operation**: Maintain Cloudflare during transition
5. **Final Cut-over**: Remove Cloudflare dependency (optional)

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Octelium cluster downtime | Medium | High | Multi-region deployment, monitoring, Cloudflare fallback |
| DNS propagation delays | Low | Medium | TTL management, status monitoring |
| Increased ops burden | High | Medium | Automation, documentation, monitoring dashboards |
| User confusion (multiple options) | Medium | Low | Clear defaults, guided setup, comprehensive docs |
| Migration failures | Low | High | Thorough testing, rollback procedures, staged rollout |

## Resource Requirements

### Development Time
- Phase 1 (Abstraction): 3-4 weeks
- Phase 2 (Tailscale): 2-3 weeks
- Phase 3 (Octelium POC): 6-8 weeks
- Phase 4 (Production): 4-6 weeks
- **Total**: 4-5 months

### Infrastructure Costs
- **Octelium Cluster**: ~$200-400/month (2-4 VMs, load balancer, monitoring)
- **Tailscale**: Scales with device count ($5-10/device/month or free tier)
- **DNS Management**: $50-100/month (depending on provider)
- **Total New**: ~$250-500/month

### Maintenance
- Octelium cluster monitoring and updates: 5-10 hrs/month
- Documentation and user support: 10-15 hrs/month
- **Total**: 15-25 hrs/month ongoing

## Success Metrics

1. **Tunnel Availability**: >99.9% uptime
2. **Migration Success Rate**: >95% of users successfully migrate
3. **Support Tickets**: <5% increase due to tunnel provider changes
4. **Cost Efficiency**: 30-50% reduction in tunnel-related costs
5. **User Satisfaction**: >80% positive feedback on new options

## Decision Points

### Immediate (Next Sprint)
- ✅ **Approve tunnel abstraction work** (Phase 1)
- ⚠️ **Decide on Tailscale Funnel priority** (Phase 2)

### Short-term (Next Quarter)
- ⚠️ **Approve Octelium POC budget** (Phase 3)
- ⚠️ **Select beta test organizations**

### Medium-term (6 months)
- ⚠️ **Evaluate Octelium POC results**
- ⚠️ **Decide on production rollout timeline**
- ⚠️ **Plan Cloudflare deprecation** (if desired)

## Appendix: Additional Resources

- Full Analysis: `docs/TUNNEL_ALTERNATIVES.md`
- Code Examples: `docs/examples/tunnel-abstraction.ts`
- Platform Architecture: `docs/PLATFORM_ARCHITECTURE.md`
- Octelium GitHub: https://github.com/octelium/octelium
- Tailscale Funnel Docs: https://tailscale.com/kb/1223/funnel/

## Questions & Answers

**Q: Why not just buy more Cloudflare accounts?**
A: Not sustainable long-term, adds operational complexity, doesn't solve architectural lock-in.

**Q: Can we use multiple tunnel providers simultaneously?**
A: Yes! The abstraction design supports this. Each device can choose its provider.

**Q: What happens if Octelium cluster goes down?**
A: Implement fallback to Cloudflare, multi-region deployment, comprehensive monitoring.

**Q: Will users need to change DNS settings?**
A: Only during migration. We handle DNS updates automatically via API.

**Q: How long does DNS propagation take?**
A: Typically 1-5 minutes with proper TTL settings. We'll monitor and provide status updates.

**Q: Can enterprise customers self-host Octelium?**
A: Future possibility. Phase 3 focuses on Portal-managed cluster, but architecture allows this.

**Q: Impact on existing apps during migration?**
A: Minimal if done correctly. Apps continue working on Cloudflare until fully migrated, then DNS cutover is atomic.

---

**Status**: ✅ Documentation Complete - Ready for Review
**Next Step**: Present to team, gather feedback, approve Phase 1 work
**Contact**: @claude[agent] for questions or clarifications
