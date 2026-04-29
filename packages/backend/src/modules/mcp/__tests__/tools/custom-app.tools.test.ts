import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { CustomAppTools } from '../../tools/custom-app.tools';
import { CustomAppService } from '@/modules/custom-apps/custom-apps.service';

describe('CustomAppTools', () => {
  let tools: CustomAppTools;
  let customAppService: MockProxy<CustomAppService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CustomAppTools, { provide: CustomAppService, useValue: mock<CustomAppService>() }],
    }).compile();
    tools = module.get<CustomAppTools>(CustomAppTools);
    customAppService = module.get(CustomAppService);
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  describe('hub_create_custom_app', () => {
    it('should create a custom app and return appUrn, appName, storeId', async () => {
      customAppService.createCustomApp.mockResolvedValue({ appUrn: 'custom:myapp', appName: 'myapp', storeId: 'custom' } as any);
      const result = await tools.createCustomApp({ name: 'myapp', config: { services: {} } });
      expect(customAppService.createCustomApp).toHaveBeenCalled();
      expect(result).toEqual({ appUrn: 'custom:myapp', appName: 'myapp', storeId: 'custom' });
    });
  });

  describe('hub_update_custom_app', () => {
    it('should update the custom app compose configuration', async () => {
      customAppService.updateCustomApp.mockResolvedValue(undefined);
      const result = await tools.updateCustomApp({ appUrn: 'custom:myapp', config: { services: {} } });
      expect(customAppService.updateCustomApp).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  describe('hub_update_app_metadata', () => {
    it('should update the app frontmatter metadata', async () => {
      customAppService.updateAppMetadata.mockResolvedValue(undefined);
      const result = await tools.updateAppMetadata({ appUrn: 'custom:myapp', data: 'description: My App' });
      expect(customAppService.updateAppMetadata).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });
});
