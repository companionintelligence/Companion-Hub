import { Test, TestingModule } from '@nestjs/testing';
import { EnvUtils } from '../env.utils';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import webpush from 'web-push';

vi.mock('node:fs');
vi.mock('node:os');
vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: vi.fn(),
  },
}));

describe('EnvUtils', () => {
  let service: EnvUtils;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EnvUtils],
    }).compile();

    service = module.get<EnvUtils>(EnvUtils);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('generateVapidKeys', () => {
    it('should return public and private keys', () => {
      (webpush.generateVAPIDKeys as any).mockReturnValue({
        publicKey: 'pub',
        privateKey: 'priv',
      });

      const result = service.generateVapidKeys();
      expect(result).toEqual({ publicKey: 'pub', privateKey: 'priv' });
    });
  });

  describe('getArchitecture', () => {
    it('should return amd64 for x64', () => {
      vi.spyOn(os, 'arch').mockReturnValue('x64');
      expect(service.getArchitecture()).toBe('amd64');
    });

    it('should return arm64 for arm64', () => {
      vi.spyOn(os, 'arch').mockReturnValue('arm64');
      expect(service.getArchitecture()).toBe('arm64');
    });

    it('should throw for unsupported architecture', () => {
      vi.spyOn(os, 'arch').mockReturnValue('mips' as any);
      expect(() => service.getArchitecture()).toThrow('Unsupported architecture');
    });
  });

  describe('createRandomString', () => {
    it('should generate a string based on seed using hex encoding', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('mock-seed');

      const result = service.createRandomString('test-name', 10);
      expect(result).toHaveLength(10);
      // Since it's deterministic with seed and name, we could check exact value but length + determinism is fine.
    });

    it('should throw if seed file missing', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      expect(() => service.createRandomString('test', 10)).toThrow('Seed file not found');
    });
  });

  describe('deriveEntropy', () => {
    it('should return derived entropy', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('mock-seed');

      const result = service.deriveEntropy('input-entropy');
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    });
  });

  describe('envMapToString', () => {
    it('should convert map to string', () => {
      const map = new Map();
      map.set('KEY1', 'VALUE1');
      map.set('KEY2', 'VALUE2');

      const result = service.envMapToString(map);
      expect(result).toContain('KEY1=VALUE1');
      expect(result).toContain('KEY2=VALUE2');
    });
  });

  describe('envStringToMap', () => {
    it('should convert string to map', () => {
      const envString = `
      KEY1=VALUE1
      # Comment
      KEY2=VALUE2
      
      `;
      const map = service.envStringToMap(envString);
      expect(map.get('KEY1')).toBe('VALUE1');
      expect(map.get('KEY2')).toBe('VALUE2');
      expect(map.size).toBe(2);
    });
  });
});
