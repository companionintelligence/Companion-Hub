import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import {
  type BridgeFailureMode,
  buildBridgeRemediation,
  classifyBridgeFailure,
  resolveBridgeTopology,
  resolveHostPlatform,
} from './backends/ollama-host-bridge';
import { OllamaBackend } from './backends/ollama.backend';

export interface OllamaInstallStatus {
  ready: boolean;
  running: boolean;
  endpointUrl: string;
  /** True when host Ollama is likely installed but unreachable from the Hub container. */
  bridgeUnreachable?: boolean;
  /**
   * How the bridge hop failed. `filtered` means a host firewall is dropping the
   * packets — the operator must fix the firewall, not Ollama.
   */
  failureMode?: BridgeFailureMode;
  /** Copy-pasteable command that fixes `filtered`. Runs on the host, not in the container. */
  remediationCommand?: string;
  /** User-facing endpoint label when ready. */
  displayEndpoint?: string;
  /** Actionable guidance when not ready. */
  hint?: string;
  error?: string;
}

@Injectable()
export class OllamaInstallerService {
  constructor(
    private readonly logger: LoggerService,
    private readonly ollamaBackend: OllamaBackend,
    private readonly hostMetrics: HostMetricsService,
  ) {}

  /** Check whether host Ollama is reachable at the configured endpoint. */
  async checkInstallation(): Promise<OllamaInstallStatus> {
    try {
      const endpointHealth = await this.ollamaBackend.healthCheck();
      const endpointUrl = this.ollamaBackend.getBaseUrl();
      const ready = endpointHealth.running && endpointHealth.healthy;
      const { bridgeUnreachable, failureMode, hint, remediationCommand } = await this.buildUnreachableHint(ready, endpointHealth.error, endpointUrl);

      this.logger.info(
        `[OllamaInstaller] Health check — ready=${ready} running=${endpointHealth.running} url=${endpointUrl} bridgeUnreachable=${bridgeUnreachable} failureMode=${failureMode}`,
      );

      return {
        ready,
        running: endpointHealth.running,
        endpointUrl,
        bridgeUnreachable,
        failureMode,
        remediationCommand,
        displayEndpoint: ready ? endpointUrl : undefined,
        hint,
        error: ready ? undefined : endpointHealth.error,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[OllamaInstaller] Health check threw unexpectedly: ${msg}`);
      const endpointUrl = this.ollamaBackend.getBaseUrl();
      const { bridgeUnreachable, failureMode, hint, remediationCommand } = await this.buildUnreachableHint(false, msg, endpointUrl);
      return {
        ready: false,
        running: false,
        endpointUrl,
        bridgeUnreachable,
        failureMode,
        remediationCommand,
        hint,
        error: msg,
      };
    }
  }

  private async buildUnreachableHint(
    ready: boolean,
    error: string | undefined,
    endpointUrl: string,
  ): Promise<{ bridgeUnreachable: boolean; failureMode: BridgeFailureMode; hint?: string; remediationCommand?: string }> {
    if (ready) return { bridgeUnreachable: false, failureMode: 'none', hint: undefined };

    const failureMode = classifyBridgeFailure(error, endpointUrl);
    if (failureMode === 'none') {
      return { bridgeUnreachable: false, failureMode, hint: undefined };
    }

    const hostProbe = await this.hostMetrics.readHostProbe();
    // Only the `filtered` path needs the concrete addresses, and resolving them
    // costs a DNS lookup — skip it otherwise.
    const topology = failureMode === 'filtered' ? await resolveBridgeTopology(endpointUrl) : undefined;
    const remediation = buildBridgeRemediation({
      mode: failureMode,
      hostPlatform: hostProbe?.platform ?? resolveHostPlatform(),
      topology,
      firewall: hostProbe?.firewall,
      service: 'Ollama',
    });

    return {
      bridgeUnreachable: true,
      failureMode,
      hint: remediation.hint,
      remediationCommand: remediation.command,
    };
  }

  /**
   * Validate Ollama availability and provide host-first guidance.
   */
  async install(): Promise<{ success: boolean; message: string }> {
    try {
      const status = await this.checkInstallation();
      if (status.ready) {
        const where = status.displayEndpoint ?? status.endpointUrl;
        return {
          success: true,
          message: `Ollama is running and reachable at ${where}.`,
        };
      }

      const hint = status.hint ?? 'Install it from ollama.com and start it on the host, then re-check.';
      const command = status.remediationCommand ? `\n\n    ${status.remediationCommand}\n` : '';
      return {
        success: false,
        message: `Ollama isn't reachable at ${status.endpointUrl}. ${hint}${command}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[OllamaInstaller] Installation failed: ${message}`);
      return {
        success: false,
        message: `Installation failed: ${message}`,
      };
    }
  }
}
