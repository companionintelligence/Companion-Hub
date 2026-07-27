import { describe, it, expect } from 'vitest';
import {
  buildBridgeConnectionHint,
  buildBridgeRemediation,
  buildFirewallAllowCommand,
  classifyBridgeFailure,
  isBridgeConnectionRefused,
  isConnectionRefused,
  toNetworkCidr,
} from '../backends/ollama-host-bridge';

const HDI = 'http://host.docker.internal:11434';

describe('ollama-host-bridge', () => {
  describe('isConnectionRefused', () => {
    it('detects ECONNREFUSED errors', () => {
      expect(isConnectionRefused(new Error('connect ECONNREFUSED 172.17.0.1:11434'))).toBe(true);
      expect(isConnectionRefused(new Error('timeout'))).toBe(false);
    });
  });

  describe('isBridgeConnectionRefused', () => {
    it('detects bridge ECONNREFUSED errors on Linux docker bridge IPs', () => {
      expect(isBridgeConnectionRefused('connect ECONNREFUSED 172.17.0.1:11434')).toBe(true);
      expect(isBridgeConnectionRefused('timeout')).toBe(false);
    });

    it('detects bridge failures when configured URL uses host.docker.internal (ECONNREFUSED)', () => {
      expect(isBridgeConnectionRefused('connect ECONNREFUSED 192.168.65.254:11434', HDI)).toBe(true);
    });

    it('detects bridge failures when configured URL uses host.docker.internal (ETIMEDOUT — Linux Docker Desktop)', () => {
      expect(isBridgeConnectionRefused('connect ETIMEDOUT fdc4:f303:9324::254:11434', HDI)).toBe(true);
    });

    it('detects bridge failures when configured URL uses host.docker.internal (EHOSTUNREACH)', () => {
      expect(isBridgeConnectionRefused('connect EHOSTUNREACH 172.20.0.1:11434', HDI)).toBe(true);
    });

    it('treats network errors as bridge failures when URL is host.docker.internal', () => {
      expect(isBridgeConnectionRefused('socket hang up', HDI)).toBe(true);
      expect(isBridgeConnectionRefused('401 Unauthorized', HDI)).toBe(false);
    });

    it('does not treat generic localhost failures as bridge failures', () => {
      expect(isBridgeConnectionRefused('connect ECONNREFUSED 127.0.0.1:11434', 'http://localhost:11434')).toBe(false);
    });

    it('returns false when error is undefined', () => {
      expect(isBridgeConnectionRefused(undefined, HDI)).toBe(false);
    });
  });

  describe('classifyBridgeFailure', () => {
    // The regression this whole change exists for: axios reports a client-side
    // timeout as ECONNABORTED with "timeout of Nms exceeded" (its default
    // transitional.clarifyTimeoutError is false, so NOT ETIMEDOUT). That string
    // matched none of the old patterns, so a firewalled bridge was classified as
    // "not a bridge problem" and no guidance was produced.
    it('classifies an axios client-side timeout as filtered', () => {
      expect(classifyBridgeFailure('timeout of 5000ms exceeded', HDI)).toBe('filtered');
      expect(classifyBridgeFailure('AxiosError: timeout of 5000ms exceeded (ECONNABORTED)', HDI)).toBe('filtered');
    });

    it('classifies undici/fetch connect timeouts as filtered', () => {
      expect(classifyBridgeFailure('ConnectTimeoutError: Connect Timeout Error', HDI)).toBe('filtered');
      expect(classifyBridgeFailure('UND_ERR_CONNECT_TIMEOUT', HDI)).toBe('filtered');
      expect(classifyBridgeFailure('The operation was aborted', HDI)).toBe('filtered');
    });

    it('classifies kernel-level timeouts and unreachable networks as filtered', () => {
      expect(classifyBridgeFailure('connect ETIMEDOUT 172.17.0.1:11434', HDI)).toBe('filtered');
      expect(classifyBridgeFailure('connect EHOSTUNREACH 172.17.0.1:11434', HDI)).toBe('filtered');
      expect(classifyBridgeFailure('connect ENETUNREACH 172.17.0.1:11434', HDI)).toBe('filtered');
    });

    // A closed port on a reachable host answers with an RST immediately, so a
    // refusal proves the bridge itself works — the opposite conclusion from a
    // timeout, and the reason these must not share one code path.
    it('classifies a refusal as refused, not filtered', () => {
      expect(classifyBridgeFailure('connect ECONNREFUSED 172.17.0.1:11434', HDI)).toBe('refused');
      expect(classifyBridgeFailure('socket hang up', HDI)).toBe('refused');
    });

    it('classifies name-resolution failures as dns', () => {
      expect(classifyBridgeFailure('getaddrinfo ENOTFOUND host.docker.internal', HDI)).toBe('dns');
      expect(classifyBridgeFailure('getaddrinfo EAI_AGAIN host.docker.internal', HDI)).toBe('dns');
    });

    it('returns none for non-network failures and unscoped errors', () => {
      expect(classifyBridgeFailure('401 Unauthorized', HDI)).toBe('none');
      expect(classifyBridgeFailure(undefined, HDI)).toBe('none');
      // Not bridge-scoped: neither the URL nor the error names the host gateway.
      expect(classifyBridgeFailure('timeout of 5000ms exceeded', 'http://localhost:11434')).toBe('none');
    });
  });

  describe('toNetworkCidr', () => {
    it('derives the network address and prefix length', () => {
      expect(toNetworkCidr('172.18.0.7', '255.255.0.0')).toBe('172.18.0.0/16');
      expect(toNetworkCidr('10.128.12.5', '255.255.255.0')).toBe('10.128.12.0/24');
      expect(toNetworkCidr('192.168.1.130', '255.255.255.128')).toBe('192.168.1.128/25');
    });

    it('returns undefined for malformed input', () => {
      expect(toNetworkCidr('not-an-ip', '255.255.0.0')).toBeUndefined();
      expect(toNetworkCidr('172.18.0.7', '255.255')).toBeUndefined();
      expect(toNetworkCidr('999.1.1.1', '255.255.0.0')).toBeUndefined();
    });
  });

  describe('buildFirewallAllowCommand', () => {
    const topology = { containerCidr: '172.18.0.0/16', gatewayIp: '172.17.0.1', port: 11434 };

    it('builds a ufw rule scoped to the container network and gateway', () => {
      expect(buildFirewallAllowCommand(topology, { kind: 'ufw', active: true })).toBe(
        'sudo ufw allow from 172.18.0.0/16 to 172.17.0.1 port 11434 proto tcp',
      );
    });

    it('defaults to ufw syntax when the firewall could not be identified', () => {
      expect(buildFirewallAllowCommand(topology)).toContain('sudo ufw allow from 172.18.0.0/16');
      expect(buildFirewallAllowCommand(topology, { kind: 'unknown', active: false })).toContain('sudo ufw allow');
    });

    it('builds firewalld, nftables and iptables equivalents', () => {
      expect(buildFirewallAllowCommand(topology, { kind: 'firewalld', active: true })).toContain('firewall-cmd --permanent --add-rich-rule');
      expect(buildFirewallAllowCommand(topology, { kind: 'nftables', active: true })).toContain('nft add rule');
      expect(buildFirewallAllowCommand(topology, { kind: 'iptables', active: true })).toContain('iptables -I INPUT');
    });

    it('returns undefined when topology is incomplete rather than emitting a placeholder', () => {
      expect(buildFirewallAllowCommand({ containerCidr: '172.18.0.0/16', port: 11434 })).toBeUndefined();
      expect(buildFirewallAllowCommand({ gatewayIp: '172.17.0.1', port: 11434 })).toBeUndefined();
      expect(buildFirewallAllowCommand({ containerCidr: '172.18.0.0/16', gatewayIp: '172.17.0.1' })).toBeUndefined();
    });
  });

  describe('buildBridgeRemediation', () => {
    const topology = { containerCidr: '172.18.0.0/16', gatewayIp: '172.17.0.1', port: 11434 };

    it('names the firewall as the cause for a filtered bridge and supplies the command', () => {
      const result = buildBridgeRemediation({ mode: 'filtered', topology, firewall: { kind: 'ufw', active: true } });

      expect(result.hint).toContain('172.17.0.1:11434');
      expect(result.hint).toContain('ufw');
      expect(result.hint).toContain('not a problem with Ollama');
      expect(result.hint).toContain('on the host');
      expect(result.command).toBe('sudo ufw allow from 172.18.0.0/16 to 172.17.0.1 port 11434 proto tcp');
    });

    it('does not repeat the old service-down advice for a filtered bridge', () => {
      const result = buildBridgeRemediation({ mode: 'filtered', hostPlatform: 'linux', topology });
      expect(result.hint).not.toContain('systemctl status ollama');
      expect(result.hint).not.toContain('OLLAMA_HOST=0.0.0.0');
    });

    it('still explains the situation when topology could not be resolved', () => {
      const result = buildBridgeRemediation({ mode: 'filtered' });
      expect(result.hint).toContain('host firewall');
      expect(result.command).toBeUndefined();
    });

    it('gives service-down guidance for a refused connection', () => {
      const result = buildBridgeRemediation({ mode: 'refused', hostPlatform: 'linux' });
      expect(result.hint).toContain('systemctl status ollama');
      expect(result.hint).toContain('OLLAMA_HOST=0.0.0.0');
      expect(result.command).toBeUndefined();
    });

    it('points at the compose host-gateway mapping for a dns failure', () => {
      const result = buildBridgeRemediation({ mode: 'dns' });
      expect(result.hint).toContain('extra_hosts');
      expect(result.command).toBeUndefined();
    });
  });

  describe('buildBridgeConnectionHint', () => {
    it('uses platform-neutral wording when host platform is unknown', () => {
      expect(buildBridgeConnectionHint()).toContain('Ensure Ollama is running on the host');
      expect(buildBridgeConnectionHint()).not.toContain('systemctl');
    });

    it('includes macOS-specific running guidance', () => {
      expect(buildBridgeConnectionHint('darwin')).toContain('menu bar');
      expect(buildBridgeConnectionHint('darwin')).not.toContain('systemctl');
    });

    it('includes Windows-specific running guidance', () => {
      expect(buildBridgeConnectionHint('win32')).toContain('system tray');
      expect(buildBridgeConnectionHint('win32')).not.toContain('systemctl');
    });

    it('includes Linux-specific running guidance', () => {
      expect(buildBridgeConnectionHint('linux')).toContain('systemctl status ollama');
    });
  });
});
