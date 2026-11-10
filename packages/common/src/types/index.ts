import { type AppUrn, zodAppUrn } from './app-urn.js';
import {
  PROVISIONING_PHASES,
  type ProvisioningPhase,
  DEGRADED_REASONS,
  type DegradedReason,
  type RegistrationCheckIn,
  type RegistrationPhaseReport,
  type RegistrationStatus,
} from './registration-status.js';

export { type AppUrn, zodAppUrn };
export {
  PROVISIONING_PHASES,
  type ProvisioningPhase,
  DEGRADED_REASONS,
  type DegradedReason,
  type RegistrationCheckIn,
  type RegistrationPhaseReport,
  type RegistrationStatus,
};
export type { AvailableDomain, AvailableDomainsResponse } from './domains.js';
// biome-ignore lint/performance/noBarrelFile: install and port-expose pickers filter through @ci-hub/common/types
export { selectOfferedDomains } from './domains.js';
export { CUSTOM_APP_DEFAULT_SHORT_DESC, PORT_EXPOSE_DEFAULT_SHORT_DESC, isLocalAppDefaultShortDesc } from './local-app-defaults.js';
export type { PublicWebIdentity, BuildOriginServerNameInput, BuildPublicWebIdentityInput } from '../public-web/identity.js';
export type { AvailableCustomDomain, TunnelCustomDomain, ParsedTunnelCustomDomains } from '../public-web/custom-domains.js';
export type { AppExposureFields, AppExposureMode } from '../public-web/exposure.js';
export type { BuildTailscalePortUrlInput, BuildTailscaleWebIdentityInput, TailscaleWebIdentity } from '../tailscale/identity.js';
export {
  buildPublicWebIdentity,
  buildFqdnSubdomain,
  buildOriginServerName,
  deriveAppSlug,
  extractDeviceSlug,
  resolvePublicDomainRoot,
  resolveRoutingSubdomain,
  RESERVED_APP_NAMES,
  sanitizeAppSubdomain,
} from '../public-web/identity.js';
export {
  collectAmbiguousCustomDomains,
  collectContestedCustomDomainTargets,
  customDomainHeldByAnotherHub,
  customDomainServesAnotherApp,
  indexCustomDomainsByTarget,
  normalizeHostname,
  normalizeStoredHostname,
  parseAvailableCustomDomains,
  parseTunnelCustomDomains,
  selectCustomDomain,
} from '../public-web/custom-domains.js';
export {
  effectiveExposureMode,
  publishesHostPort,
  publishesPublicWebRoute,
  servedExposureMode,
  storedExposureForm,
  storedHostPortForm,
} from '../public-web/exposure.js';
export { buildTailscaleNodeFqdn, buildTailscalePortHost, buildTailscalePortUrl, buildTailscaleWebIdentity } from '../tailscale/identity.js';
export type { DesktopReleaseManifest } from './desktop-release.js';
export { desktopInstallerUrl, desktopReleaseCdn, isTrustedDownloadUrlForHost, platformManifestKey } from './desktop-release.js';
export { INFERENCE_BACKEND_TYPES } from './inference.js';
export { defaultChatModelId } from '../inference/default-chat-model.js';
export { gpuRuntimeReady } from '../inference/gpu-runtime.js';
export { OPERATOR_MINTABLE_SCOPES } from './api-key-scopes.js';
export type { OperatorMintableScope } from './api-key-scopes.js';
export type {
  HardwareProfile,
  HardwareTier,
  MemoryBudget,
  ModelMemoryUsage,
  ModelMemoryUsageEntry,
  ModelMemoryUsageSource,
  InferenceBackendType,
  ModelModality,
  ModelPurpose,
  ModelState,
  TierRecommendation,
  CuratedModel,
  ModelContextPlan,
  TrackedModel,
  CloudProviderType,
  CloudProviderConfig,
  CloudProviderStatus,
  InferenceModelInfo,
  InferenceStatus,
  BackendHealthStatus,
  BackendModelInfo,
  BackendResidency,
  ResidencySource,
  ResidentModel,
  ResidencyReport,
  PullProgress,
} from './inference.js';
export type {
  HostPlatform,
  HostCpuArch,
  HostMetricsSource,
  RuntimeKind,
  HostMetricsHostSection,
  HostMetricsContainerSection,
  HostMetricsProbeFile,
  HostMetricsDisplayLoad,
  HostFirewallKind,
  HostFirewallInfo,
} from './host-metrics.js';
