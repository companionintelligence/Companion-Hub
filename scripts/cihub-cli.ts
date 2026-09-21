/**
 * Public surface of the `cihub` command modules.
 *
 * Every handler now lives in `scripts/lib/cli-*.ts`; this file re-exports them under the names
 * the CLI has always published, so callers and `__tests__/cihub-cli.test.ts` keep one stable
 * import site while the implementation stays split by concern.
 *
 * New code should import from the owning module directly rather than through here.
 */
import { parseEnvFile, upsertEnvVar } from './env-file';
import { allowedEnvs, BASE_COMMAND, type HubEnv, type RegisterHubOptions, type StartMode } from './lib/cli-types';
import {
  normalizeCliArgs,
  normalizeDetachedFlag,
  normalizeRegisterFlags,
  printRemovedCommand,
  resolveEnvFromArgs,
  resolveUpStartMode,
  usageAndExit,
} from './lib/cli-args';
import { isApplianceMode, isHubRepoRoot } from './lib/cli-repo-context';
import { resolveWizardEnvInput, resolveWizardActionInput, runWizard } from './lib/cli-wizard';
import { runModelsCommand, setMcpState, runPublicWebCommand } from './lib/cli-models';
import { logsHub, doctorHub, uninstallHub, findComposeName, showStatus } from './lib/cli-doctor';
import { shouldRetryApkMirrorWithHostNetwork, startHub, setupHub, printConfig } from './lib/cli-lifecycle';
import { downHub, restartHub, cleanHub, resetHub, recreateHub } from './lib/cli-teardown';
import { showDeviceId, registerHub } from './lib/cli-register';
import { POOL_SUBCOMMANDS, type ParsedPoolArgs, parsePoolArgs, isPlausiblePeerFqdn, type PoolSubcommand, runPoolCommand } from './lib/cli-pool';
import { confirmDestructiveAction } from './lib/cli-prompt';
import { type HubContext, resolveHubContext, isFirstRun } from './lib/hub-context';
import {
  renderVersion,
  firstPathFromLookupOutput,
  resolveCompanionHubBinary,
  runHostUpdate,
  runConnectCommand,
  runVersionCommand,
  fetchHubBuildInfo,
  formatHubBuildLines,
  resolveDefaultHubApiBase,
} from './lib/cli-update';
import { parseAppRuntimeArgs, appStatusColor, runAppCommand } from './lib/cli-app';
import {
  apiKeyTableHasCapability,
  buildApiKeyInsertSql,
  formatApiKeyRows,
  isValidApiKeyName,
  parseApiKeyScopes,
  runApiKeyCommand,
  sqlQuote,
} from './lib/cli-api-key';
import {
  BOX_CHARS,
  STEP_ICONS,
  box,
  printMessageBox,
  renderBanner,
  renderHelp,
  renderManPage,
  renderStep,
  renderWizardWelcome,
  sanitizeForBox,
  stripAnsi,
  type StepStatus,
} from './lib/cli-ui';
import { buildEnvOverrides, ensureLocalDevRuntimeEnv, getComposeFiles, mergeComposeProfilesFromEnvFile } from './lib/cli-compose-env';

export { allowedEnvs, BASE_COMMAND, type HubEnv };
export type { StepStatus };
export { STEP_ICONS, BOX_CHARS };
export { stripAnsi, sanitizeForBox, box, printMessageBox, renderStep, renderBanner, renderWizardWelcome, renderHelp, renderManPage };
export { getComposeFiles, mergeComposeProfilesFromEnvFile, buildEnvOverrides, ensureLocalDevRuntimeEnv };
export { parseEnvFile, upsertEnvVar };
export { normalizeCliArgs, resolveEnvFromArgs, printRemovedCommand, normalizeDetachedFlag, normalizeRegisterFlags, resolveUpStartMode, usageAndExit };
export { isHubRepoRoot, isApplianceMode };
export type { RegisterHubOptions, StartMode };
export { resolveWizardEnvInput, resolveWizardActionInput, runWizard };
export { runModelsCommand, setMcpState, runPublicWebCommand };
export { logsHub, doctorHub, uninstallHub, findComposeName, showStatus };
export { shouldRetryApkMirrorWithHostNetwork, startHub, setupHub, printConfig };
export { downHub, restartHub, cleanHub, resetHub, recreateHub };
export { showDeviceId, registerHub };
export { POOL_SUBCOMMANDS, parsePoolArgs, isPlausiblePeerFqdn, runPoolCommand };
export type { ParsedPoolArgs, PoolSubcommand };
export { confirmDestructiveAction };
export { resolveHubContext, isFirstRun };
export type { HubContext };
export {
  renderVersion,
  firstPathFromLookupOutput,
  resolveCompanionHubBinary,
  runHostUpdate,
  runConnectCommand,
  runVersionCommand,
  fetchHubBuildInfo,
  formatHubBuildLines,
  resolveDefaultHubApiBase,
};
export { parseAppRuntimeArgs, appStatusColor, runAppCommand };
export { sqlQuote, isValidApiKeyName, parseApiKeyScopes, buildApiKeyInsertSql, apiKeyTableHasCapability, formatApiKeyRows, runApiKeyCommand };
