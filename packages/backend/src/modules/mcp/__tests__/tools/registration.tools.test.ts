import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { RegistrationTools } from '../../tools/registration.tools';

describe('RegistrationTools', () => {
  let tools: RegistrationTools;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RegistrationTools],
    }).compile();

    tools = module.get<RegistrationTools>(RegistrationTools);
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  // --- RN-1: hub_registration_status ---

  describe('hub_registration_status', () => {
    // S-RN-1.1: returns phase, degradedReasons, registered
    it.todo('should return registration phase (unregistered, paired, provisioning, locally_ready, publicly_ready, degraded)');
    it.todo('should return degradedReasons array');
    it.todo('should return registered boolean');
  });

  // --- RN-2: hub_cloudflare_status ---

  describe('hub_cloudflare_status', () => {
    // S-RN-2.1: returns { tunnelEnabled, tunnelId, dnsEnabled }
    it.todo('should return tunnelEnabled boolean');
    it.todo('should return tunnelId string');
    it.todo('should return dnsEnabled boolean');
  });

  // --- RN-3: hub_probe_domain ---

  describe('hub_probe_domain', () => {
    // S-RN-3.1: returns { ready: boolean }
    it.todo('should return ready: true when domain is serving the Hub');
    it.todo('should return ready: false when domain is not reachable');
    it.todo('should require url parameter');
  });

  // --- RN-4: hub_check_url_availability ---

  describe('hub_check_url_availability', () => {
    // S-RN-4.1: returns { available, status?, error?, isDnsError? }
    it.todo('should return available: true with status code for accessible URL');
    it.todo('should return available: false with error for inaccessible URL');
    it.todo('should indicate isDnsError when the failure is DNS-related');
    it.todo('should require url parameter');
  });
});
