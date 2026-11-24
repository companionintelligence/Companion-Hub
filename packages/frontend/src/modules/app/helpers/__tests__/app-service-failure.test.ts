import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import messages from '@ci-hub/common/i18n/translations/en.json';
import { appServiceFailureText } from '../app-service-failure';

/** The English strings, filled in as i18next does. Reads the real file, so a renamed or missing key fails here. */
const t = ((key: keyof typeof messages, values: Record<string, unknown> = {}) =>
  messages[key].replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name]))) as unknown as TFunction;

describe('appServiceFailureText', () => {
  it('names the service, the exit code and the last log line', () => {
    expect(appServiceFailureText(t, { kind: 'restarting', service: 'summary-service', exitCode: 126, logLine: 'permission denied' })).toBe(
      'summary-service keeps restarting (exit 126): permission denied',
    );
  });

  it('reads without a log line or an exit code', () => {
    expect(appServiceFailureText(t, { kind: 'restarting', service: 'api', exitCode: 1 })).toBe('api keeps restarting (exit 1)');
    expect(appServiceFailureText(t, { kind: 'restarting', service: 'api' })).toBe('api keeps restarting');
  });

  it('says a service exited and how many more failed', () => {
    expect(appServiceFailureText(t, { kind: 'exited', service: 'migrate', others: 2, exitCode: 3 })).toBe('migrate and 2 more exited (exit 3)');
    expect(appServiceFailureText(t, { kind: 'exited', service: 'migrate' })).toBe('migrate exited');
  });

  it('has a sentence for an app with nothing running', () => {
    expect(appServiceFailureText(t, { kind: 'none_running' })).toBe("None of this app's services are running");
  });
});
