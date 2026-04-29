import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppConfigTools } from '../../tools/app-config.tools';

describe('AppConfigTools', () => {
  let tools: AppConfigTools;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AppConfigTools],
    }).compile();

    tools = module.get<AppConfigTools>(AppConfigTools);
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  // --- AC-1: hub_get_user_config ---

  describe('hub_get_user_config', () => {
    // S-AC-1.1: returns { dockerCompose, appEnv, isEnabled }
    it.todo('should return dockerCompose string or null');
    it.todo('should return appEnv string or null');
    it.todo('should return isEnabled boolean');
  });

  // --- AC-2: hub_update_user_config ---

  describe('hub_update_user_config', () => {
    // S-AC-2.1: accepts { appUrn, dockerCompose, appEnv } and returns { success: true }
    it.todo('should update user config files and return success');
    it.todo('should require appUrn, dockerCompose, and appEnv parameters');
  });

  // --- AC-3: hub_enable_user_config / hub_disable_user_config ---

  describe('hub_enable_user_config', () => {
    // S-AC-3.1: accepts { appUrn } and toggles enabled state
    it.todo('should enable user config for the specified app');
  });

  describe('hub_disable_user_config', () => {
    // S-AC-3.1: accepts { appUrn } and toggles enabled state
    it.todo('should disable user config for the specified app');
  });

  // --- AC-4: hub_ignore_app_version / hub_unignore_app_version ---

  describe('hub_ignore_app_version', () => {
    // S-AC-4.1: accepts { appUrn } and updates ignored version state
    it.todo('should mark the app version as ignored');
  });

  describe('hub_unignore_app_version', () => {
    // S-AC-4.1: accepts { appUrn } and updates ignored version state
    it.todo('should unmark the app version as ignored');
  });
});
