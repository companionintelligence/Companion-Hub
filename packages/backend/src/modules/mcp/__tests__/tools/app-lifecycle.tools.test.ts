import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppLifecycleTools } from '../../tools/app-lifecycle.tools';

describe('AppLifecycleTools', () => {
  let tools: AppLifecycleTools;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AppLifecycleTools],
    }).compile();

    tools = module.get<AppLifecycleTools>(AppLifecycleTools);
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  // --- AL-1: hub_install_app ---

  describe('hub_install_app', () => {
    // S-AL-1.1: enqueues install command and returns { requestId }
    it.todo('should enqueue an install command and return a requestId');

    // S-AL-1.2: form accepts all appFormSchema fields plus app-specific env variables
    it.todo('should accept port, exposed, exposedLocal, openPort, domain fields');
    it.todo('should accept isVisibleOnGuestDashboard, enableAuth, localSubdomain fields');
    it.todo('should accept maxBackups, skipEnv, skipPull, skipRun fields');
    it.todo('should accept app-specific form field env variables');

    // S-AL-1.3: already installed app returns error
    it.todo('should return error when app is already installed');
  });

  // --- AL-2: hub_start_app, hub_stop_app, hub_restart_app ---

  describe('hub_start_app', () => {
    // S-AL-2.1: accepts { appUrn } and returns { requestId }
    it.todo('should accept appUrn and return requestId');

    // S-AL-2.2: not installed app returns error
    it.todo('should return error when app is not installed');
  });

  describe('hub_stop_app', () => {
    // S-AL-2.1: accepts { appUrn } and returns { requestId }
    it.todo('should accept appUrn and return requestId');

    // S-AL-2.3: already stopped app returns error
    it.todo('should return error when app is already stopped');
  });

  describe('hub_restart_app', () => {
    // S-AL-2.1: accepts { appUrn } and returns { requestId }
    it.todo('should accept appUrn and return requestId');
  });

  // --- AL-3: hub_uninstall_app ---

  describe('hub_uninstall_app', () => {
    // S-AL-3.1: accepts { appUrn, removeBackups? } with default false
    it.todo('should enqueue uninstall command with removeBackups defaulting to false');
    it.todo('should pass removeBackups: true when specified');

    // S-AL-3.2: returns { requestId }
    it.todo('should return a requestId');
  });

  // --- AL-4: hub_reset_app ---

  describe('hub_reset_app', () => {
    // S-AL-4.1: enqueues reset and returns { requestId }
    it.todo('should enqueue a reset command and return requestId');
  });

  // --- AL-5: hub_update_app ---

  describe('hub_update_app', () => {
    // S-AL-5.1: accepts { appUrn, performBackup? } with default true
    it.todo('should enqueue update command with performBackup defaulting to true');
    it.todo('should pass performBackup: false when specified');

    // S-AL-5.2: returns { requestId }
    it.todo('should return a requestId');
  });

  // --- AL-6: hub_update_app_config ---

  describe('hub_update_app_config', () => {
    // S-AL-6.1: accepts { appUrn, form } and returns { requestId }
    it.todo('should enqueue config update and return requestId');
    it.todo('should pass form values to the lifecycle service');
  });

  // --- AL-7: bulk lifecycle tools ---

  describe('hub_update_all_apps', () => {
    // S-AL-7.1: accepts no arguments
    it.todo('should accept no arguments');

    // S-AL-7.2: invokes service and returns summary
    it.todo('should invoke bulk update and return summary result');
  });

  describe('hub_start_all_apps', () => {
    it.todo('should accept no arguments');
    it.todo('should invoke bulk start and return summary result');
  });

  describe('hub_stop_all_apps', () => {
    it.todo('should accept no arguments');
    it.todo('should invoke bulk stop and return summary result');
  });

  describe('hub_restart_all_apps', () => {
    it.todo('should accept no arguments');
    it.todo('should invoke bulk restart and return summary result');
  });
});
