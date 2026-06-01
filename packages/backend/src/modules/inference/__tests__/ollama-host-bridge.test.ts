import { describe, it, expect } from 'vitest';
import { buildBridgeConnectionHint, isBridgeConnectionRefused, isConnectionRefused } from '../backends/ollama-host-bridge';

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

    it('detects bridge failures when configured URL uses host.docker.internal', () => {
      expect(isBridgeConnectionRefused('connect ECONNREFUSED 192.168.65.254:11434', 'http://host.docker.internal:11434')).toBe(true);
    });

    it('does not treat generic localhost failures as bridge failures', () => {
      expect(isBridgeConnectionRefused('connect ECONNREFUSED 127.0.0.1:11434', 'http://localhost:11434')).toBe(false);
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
