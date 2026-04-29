import { Injectable } from '@nestjs/common';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { castAppUrn } from '@/common/helpers/app-helpers';

@Injectable()
export class AppLifecycleTools {
  constructor(private readonly appLifecycleService: AppLifecycleService) {}

  async installApp(params: { appUrn: string; form?: Record<string, unknown> }) {
    return this.appLifecycleService.installApp({
      appUrn: castAppUrn(params.appUrn),
      form: params.form ?? {},
    });
  }

  async startApp(params: { appUrn: string }) {
    return this.appLifecycleService.startApp({ appUrn: castAppUrn(params.appUrn) });
  }

  async stopApp(params: { appUrn: string }) {
    return this.appLifecycleService.stopApp({ appUrn: castAppUrn(params.appUrn) });
  }

  async restartApp(params: { appUrn: string }) {
    return this.appLifecycleService.restartApp({ appUrn: castAppUrn(params.appUrn) });
  }

  async uninstallApp(params: { appUrn: string; removeBackups?: boolean }) {
    return this.appLifecycleService.uninstallApp({
      appUrn: castAppUrn(params.appUrn),
      removeBackups: params.removeBackups ?? false,
    });
  }

  async resetApp(params: { appUrn: string }) {
    return this.appLifecycleService.resetApp({ appUrn: castAppUrn(params.appUrn) });
  }

  async updateApp(params: { appUrn: string; performBackup?: boolean }) {
    return this.appLifecycleService.updateApp({
      appUrn: castAppUrn(params.appUrn),
      performBackup: params.performBackup ?? true,
    });
  }

  async updateAppConfig(params: { appUrn: string; form: Record<string, unknown> }) {
    return this.appLifecycleService.updateAppConfig({
      appUrn: castAppUrn(params.appUrn),
      form: params.form,
    });
  }

  async updateAllApps() {
    return this.appLifecycleService.updateAllApps();
  }

  async startAllApps() {
    return this.appLifecycleService.startAllApps();
  }

  async stopAllApps() {
    return this.appLifecycleService.stopAllApps();
  }

  async restartAllApps() {
    return this.appLifecycleService.restartAllApps();
  }
}
