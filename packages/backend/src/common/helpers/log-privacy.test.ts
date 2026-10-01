import { describe, expect, it } from 'vitest';
import { hashEmailForLog, redactSecretsForLog } from './log-privacy';

describe('hashEmailForLog', () => {
  it('returns a stable truncated hash for the same email', () => {
    expect(hashEmailForLog('User@Example.com')).toBe(hashEmailForLog('user@example.com'));
    expect(hashEmailForLog('user@example.com')).toHaveLength(12);
  });

  it('returns a placeholder for empty input', () => {
    expect(hashEmailForLog('   ')).toBe('[empty]');
  });
});

describe('redactSecretsForLog', () => {
  it('replaces credentials at any depth and keeps every other field', () => {
    const body = {
      themeColor: 'red',
      inferenceVllmApiKey: 'vllm-key',
      inferenceCloudProviders: [
        { provider: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o', enabled: true },
      ],
      database: { host: 'ci-hub-db', port: 5432, username: 'tipi', password: 'pg-password' },
    };

    expect(redactSecretsForLog(body)).toEqual({
      themeColor: 'red',
      inferenceVllmApiKey: '[redacted]',
      inferenceCloudProviders: [
        { provider: 'openai', apiKey: '[redacted]', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o', enabled: true },
      ],
      database: { host: 'ci-hub-db', port: 5432, username: 'tipi', password: '[redacted]' },
    });
  });

  it.each([
    // The configuration, as `ConfigurationService.configure` builds it.
    'password',
    'jwtSecret',
    'forwardAuthSecret',
    'ciHubApiKey',
    'ciHubMoveKey',
    'hubLocalKey',
    'portalPushKeyPending',
    'inferenceVllmApiKey',
    'apiKey',
    // Request bodies, including every name the auth guard redacted before this helper existed.
    'currentPassword',
    'newPassword',
    'token',
    'api_key',
    'secret',
    'vllmApiKey',
    // Portal's registration answer.
    'tunnel_token',
    // Variables an app's install form posts.
    'ADMIN_PASSWORD',
    'ANTHROPIC_API_KEY',
    'APP_KEYS',
    'AUTH_SECRET',
    'APP_HF_TOKEN',
    'AGENT_PASSPHRASE',
    'ADMIN_CREDENTIAL',
    'SAMBA_PASS',
    'MIGPT_PWD',
    'DEFAULT_ROOT_PSW',
    'VNC_PW',
  ])('redacts %s', (name) => {
    expect(redactSecretsForLog({ [name]: 'value' })).toEqual({ [name]: '[redacted]' });
  });

  it.each([
    'portalPushKeyPrefix',
    'portalPushKeyDeliveredAt',
    'ciHubOrganizationId',
    'forwardAuthUrl',
    'envFilePath',
    'username',
    'NGINX_BYPASS',
    'tunnel_id',
  ])('leaves %s readable', (name) => {
    expect(redactSecretsForLog({ [name]: 'value' })).toEqual({ [name]: 'value' });
  });

  it('keeps flags and counts named after a credential', () => {
    const fields = { disablePasswordReset: true, localPasswordSet: false, hubPoolMaxPromptTokens: 16000, secret: true };

    expect(redactSecretsForLog(fields)).toEqual(fields);
  });

  it('replaces a number held under a credential name', () => {
    // The auth guard logs a body before validation rejects it, so a password or PIN sent as a JSON
    // number would reach the log as sent. The guard's old list hid every type under its names.
    expect(redactSecretsForLog({ currentPassword: 12345678, token: 123456, hubPoolMaxPromptTokens: 16000 })).toEqual({
      currentPassword: '[redacted]',
      token: '[redacted]',
      hubPoolMaxPromptTokens: 16000,
    });
  });

  it('shows whether a credential is set: an empty or null one keeps its value', () => {
    const fields = { forwardAuthSecret: '', ciHubApiKey: null, ciHubMoveKey: undefined };

    expect(redactSecretsForLog(fields)).toEqual(fields);
  });

  it('replaces a whole object or list held under a credential name', () => {
    expect(redactSecretsForLog({ credentials: { AccountTag: 'account', TunnelSecret: 'secret' }, APP_KEYS: ['one', 'two'] })).toEqual({
      credentials: '[redacted]',
      APP_KEYS: '[redacted]',
    });
  });

  it('leaves its input unchanged', () => {
    const config = { database: { password: 'pg-password' }, userSettings: { inferenceCloudProviders: [{ apiKey: 'sk-test' }] } };

    redactSecretsForLog(config);

    expect(config).toEqual({ database: { password: 'pg-password' }, userSettings: { inferenceCloudProviders: [{ apiKey: 'sk-test' }] } });
  });

  it('returns a value that is not an object as it is', () => {
    expect(redactSecretsForLog(undefined)).toBeUndefined();
    expect(redactSecretsForLog(null)).toBeNull();
    expect(redactSecretsForLog('text')).toBe('text');
    expect(redactSecretsForLog(42)).toBe(42);
  });
});
