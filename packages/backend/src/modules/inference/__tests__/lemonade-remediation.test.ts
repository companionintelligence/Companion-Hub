import { describe, expect, it } from 'vitest';
import { buildLemonadeRemediation, classifyLemonadeFailure } from '../backends/lemonade-remediation';

const ENDPOINT = 'http://host.docker.internal:13305';
const topology = { gatewayIp: '172.17.0.1', containerCidr: '172.18.0.0/16', port: 13305 };

describe('classifyLemonadeFailure', () => {
  it('calls a 401 or 403 a key problem, not a network one', () => {
    expect(classifyLemonadeFailure('Request failed with status code 401', ENDPOINT)).toBe('auth');
    expect(classifyLemonadeFailure('Request failed with status code 403', ENDPOINT)).toBe('auth');
  });

  it('otherwise classifies the bridge failure as for Ollama', () => {
    expect(classifyLemonadeFailure('connect ECONNREFUSED 172.17.0.1:13305', ENDPOINT)).toBe('refused');
    expect(classifyLemonadeFailure('timeout of 5000ms exceeded', ENDPOINT)).toBe('filtered');
    expect(classifyLemonadeFailure('getaddrinfo ENOTFOUND host.docker.internal', ENDPOINT)).toBe('dns');
  });
});

describe('buildLemonadeRemediation', () => {
  it("admits both the Hub's network and the app subnet to Lemonade's port, for the host's firewall", () => {
    const ufw = buildLemonadeRemediation({ mode: 'refused', hostPlatform: 'linux', topology, apiKeyConfigured: false });
    expect(ufw.firewallCommands).toEqual([
      'sudo ufw allow from 172.18.0.0/16 to 172.17.0.1 port 13305 proto tcp',
      'sudo ufw allow from 10.128.0.0/9 to 172.17.0.1 port 13305 proto tcp',
    ]);

    const firewalld = buildLemonadeRemediation({
      mode: 'filtered',
      hostPlatform: 'linux',
      firewall: { kind: 'firewalld', active: true },
      topology: { ...topology, port: 13400 },
      apiKeyConfigured: false,
    });
    expect(firewalld.firewallCommands).toHaveLength(2);
    expect(firewalld.firewallCommands[1]).toContain('source address=10.128.0.0/9 destination address=172.17.0.1 port port=13400');
    expect(firewalld.hint).toContain('not a problem with Lemonade');
  });

  it('gives no firewall commands where there is no enabled firewall, or on macOS and Windows', () => {
    expect(
      buildLemonadeRemediation({
        mode: 'refused',
        hostPlatform: 'linux',
        firewall: { kind: 'ufw', active: false },
        topology,
        apiKeyConfigured: false,
      }).firewallCommands,
    ).toEqual([]);
    expect(
      buildLemonadeRemediation({
        mode: 'refused',
        hostPlatform: 'linux',
        firewall: { kind: 'none', active: false },
        topology,
        apiKeyConfigured: false,
      }).firewallCommands,
    ).toEqual([]);
    expect(buildLemonadeRemediation({ mode: 'filtered', hostPlatform: 'darwin', topology, apiKeyConfigured: false }).firewallCommands).toEqual([]);
  });

  it('points a refused key at the key, never at a wider bind or an open port', () => {
    const configured = buildLemonadeRemediation({ mode: 'auth', hostPlatform: 'linux', topology, apiKeyConfigured: true });
    expect(configured.hint).toContain('refused the Hub');
    expect(configured.firewallCommands).toEqual([]);

    const missing = buildLemonadeRemediation({ mode: 'auth', hostPlatform: 'linux', apiKeyConfigured: false });
    expect(missing.hint).toContain("Add Lemonade's LEMONADE_API_KEY to the Hub's .env");
  });

  it("leaves a refused connection's steps to the card, which translates them", () => {
    expect(buildLemonadeRemediation({ mode: 'refused', hostPlatform: 'linux', topology, apiKeyConfigured: false }).hint).toBeUndefined();
  });
});
