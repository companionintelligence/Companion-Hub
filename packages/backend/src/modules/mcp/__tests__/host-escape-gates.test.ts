import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppStoreService } from '@/modules/app-stores/app-store.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { type ApiKeyCapability, DEFAULT_API_KEY_CAPABILITY } from '@/modules/api-keys/api-key.capabilities';
import { mcpCallContext } from '../mcp-call-context';
import { DestructiveToolDisabledError, McpToolRegistry } from '../mcp-tool-registry.service';
import { AppLifecycleTools } from '../tools/app-lifecycle.tools';
import { MarketplaceTools } from '../tools/marketplace.tools';

/**
 * The two host-escape paths from CI-Hub#1302, driven end to end through the REAL registry gate with a
 * REAL tool registration — not the tool classes' own tests, which mock the registry and so never
 * reach the check that decides any of this.
 *
 * Every refusal case is written as the attack: the key holds the capability the appliance hands out
 * by default, and the assertion is that the underlying service was never called. Every refusal is
 * paired with the same call at 'full', because a gate that refuses everybody is an outage, not a
 * fix.
 */
describe('MCP host-escape gates (R2-HUBHOSTESCAPE-5, -6)', () => {
  let registry: McpToolRegistry;
  let appStores: MockProxy<AppStoreService>;
  let lifecycle: MockProxy<AppLifecycleService>;

  /** The capability a leaked key most likely holds: the one every create path assigns by default. */
  const LEAKED = DEFAULT_API_KEY_CAPABILITY;

  /** A well-formed exposure form, so a refusal can only be the gate and never a validation error. */
  const exposureForm = { port: 8080, exposureMode: 'cloudflare', exposedLocal: true, openPort: false, localSubdomain: 'shop' };

  /**
   * A tools/call from an operator-created key holding `capability`, run the way `McpController` runs
   * it: inside the key's context. The lifecycle tools act only for a named caller (CI-Hub#1397), so a
   * call with no key behind it is not one this surface can receive.
   */
  const callAs = (capability: ApiKeyCapability, name: string, params: Record<string, unknown>) =>
    mcpCallContext.run({ id: 1, name: 'agent', capability, ownerAppUrn: null }, () => registry.callTool(name, params, { capability }));

  beforeEach(() => {
    registry = new McpToolRegistry();
    appStores = mock<AppStoreService>();
    lifecycle = mock<AppLifecycleService>();
    new MarketplaceTools(mock<MarketplaceService>(), appStores, registry).onModuleInit();
    new AppLifecycleTools(lifecycle, registry).onModuleInit();

    appStores.createAppStore.mockResolvedValue({ slug: 'tools' } as never);
    appStores.updateAppStore.mockResolvedValue({} as never);
    lifecycle.validateAppConfig.mockResolvedValue({ valid: true, errors: [] } as never);
    lifecycle.installApp.mockResolvedValue({ requestId: 'install-1' } as never);
    lifecycle.updateAppConfig.mockResolvedValue({ requestId: 'config-1' } as never);
  });

  it('is written against the capability the appliance actually issues by default', () => {
    // If this ever stops being 'write', every "leaked key" case below is testing the wrong tier.
    expect(LEAKED).toBe('write');
  });

  describe('R2-HUBHOSTESCAPE-5 — adding an install source', () => {
    it('refuses hub_add_app_store to a default-capability key, and never reaches the store service', async () => {
      await expect(callAs(LEAKED, 'hub_add_app_store', { name: 'tools', url: 'https://github.com/attacker/store' })).rejects.toThrow(
        DestructiveToolDisabledError,
      );
      expect(appStores.createAppStore).not.toHaveBeenCalled();
    });

    it('refuses hub_update_app_store to a default-capability key — re-enabling a store re-arms it', async () => {
      await expect(callAs(LEAKED, 'hub_update_app_store', { storeId: 'tools', name: 'tools', enabled: true })).rejects.toThrow(
        DestructiveToolDisabledError,
      );
      expect(appStores.updateAppStore).not.toHaveBeenCalled();
    });

    it('still lets a full-capability key add and update a store', async () => {
      await expect(callAs('full', 'hub_add_app_store', { name: 'tools', url: 'https://github.com/acme/store' })).resolves.toEqual({ slug: 'tools' });
      await expect(callAs('full', 'hub_update_app_store', { storeId: 'tools', name: 'tools', enabled: true })).resolves.toEqual({ success: true });
    });

    it('does not offer either tool to a default-capability key in tools/list', async () => {
      // Statically destructive, so the agent is told up front rather than burning a turn on a refusal.
      const visible = registry.listToolsForCapability(LEAKED).map((tool) => tool.name);
      expect(visible).not.toContain('hub_add_app_store');
      expect(visible).not.toContain('hub_update_app_store');
      expect(registry.listToolsForCapability('full').map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['hub_add_app_store', 'hub_update_app_store']),
      );
    });
  });

  describe('R2-HUBHOSTESCAPE-6 — taking a custom domain', () => {
    it('refuses hub_update_app_config carrying a customDomain, and never reaches the lifecycle service', async () => {
      await expect(
        callAs(LEAKED, 'hub_update_app_config', {
          appUrn: 'evil-app:third-party',
          form: { ...exposureForm, customDomain: 'shop.acme.com', customDomainTakeover: true },
        }),
      ).rejects.toThrow(DestructiveToolDisabledError);
      expect(lifecycle.updateAppConfig).not.toHaveBeenCalled();
    });

    it("refuses an empty customDomain — parking a sibling app's live domain is the same authority", async () => {
      await expect(
        callAs(LEAKED, 'hub_update_app_config', { appUrn: 'victim-app:ci-store', form: { ...exposureForm, customDomain: '' } }),
      ).rejects.toThrow(DestructiveToolDisabledError);
      expect(lifecycle.updateAppConfig).not.toHaveBeenCalled();
    });

    it('refuses a bare customDomainTakeover, which asks for the authority without naming the target', async () => {
      await expect(
        callAs(LEAKED, 'hub_update_app_config', { appUrn: 'evil-app:third-party', form: { ...exposureForm, customDomainTakeover: true } }),
      ).rejects.toThrow(DestructiveToolDisabledError);
      expect(lifecycle.updateAppConfig).not.toHaveBeenCalled();
    });

    it('refuses hub_install_app carrying a customDomain, so the install path is not the way around it', async () => {
      await expect(
        callAs(LEAKED, 'hub_install_app', {
          appUrn: 'evil-app:third-party',
          form: { ...exposureForm, customDomain: 'shop.acme.com', customDomainTakeover: true },
        }),
      ).rejects.toThrow(DestructiveToolDisabledError);
      expect(lifecycle.installApp).not.toHaveBeenCalled();
    });

    it('leaves ordinary installs and config edits to a default-capability key', async () => {
      // The gate has to be a gate, not a ban: 'write' still means "install, start, stop, reconfigure".
      await expect(callAs(LEAKED, 'hub_install_app', { appUrn: 'nextcloud:ci-store', form: exposureForm })).resolves.toEqual({
        requestId: 'install-1',
      });
      await expect(callAs(LEAKED, 'hub_update_app_config', { appUrn: 'nextcloud:ci-store', form: { port: 9090 } })).resolves.toEqual({
        requestId: 'config-1',
      });
      expect(registry.listToolsForCapability(LEAKED).map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['hub_install_app', 'hub_update_app_config']),
      );
    });

    it('still lets a full-capability key set a custom domain, and passes the form through unchanged', async () => {
      const form = { ...exposureForm, customDomain: 'shop.acme.com', customDomainTakeover: true };
      await expect(callAs('full', 'hub_update_app_config', { appUrn: 'nextcloud:ci-store', form })).resolves.toEqual({
        requestId: 'config-1',
      });
      expect(lifecycle.updateAppConfig).toHaveBeenCalledWith(expect.objectContaining({ form }));
    });
  });
});
