import { describe, expect, it } from 'vitest';
import { appInfoSchema, HUB_OWNED_APP_ENV_VARS } from '../app-info.js';

const baseApp = {
  id: 'app',
  urn: 'app:home-lab',
  name: 'App',
  author: 'Someone',
  available: true,
  short_desc: 'An app',
  source: 'https://example.com/app',
  port: 8080,
};

const issuesOf = (input: Record<string, unknown>) => {
  const parsed = appInfoSchema.safeParse({ ...baseApp, ...input });
  return parsed.success ? [] : parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]);
};

/*
 * The Hub writes these into every app's env before the manifest's form fields, and its Traefik
 * label check and its sandbox take them as the app's own. A manifest that named one would replace
 * the Hub's value with its own.
 */
describe('appInfoSchema: values the Hub sets for every app', () => {
  it('holds the app’s id, name, store, URN, hosts and data directory', () => {
    expect([...HUB_OWNED_APP_ENV_VARS].sort()).toEqual([
      'APP_BASE_HOST',
      'APP_DATA_DIR',
      'APP_DOMAIN',
      'APP_ID',
      'APP_LOCAL_DOMAIN',
      'APP_NAME',
      'APP_STORE_ID',
      'APP_URN',
    ]);
  });

  describe.each([...HUB_OWNED_APP_ENV_VARS])('%s', (name) => {
    const refused = `${name} is set by the Hub for every app, so a manifest can't set it`;

    it('can’t be a form field', () => {
      expect(issuesOf({ form_fields: [{ type: 'text', label: 'Name', env_variable: name }] })).toEqual([['form_fields.0.env_variable', refused]]);
    });

    it('can’t be a form field with a default', () => {
      expect(issuesOf({ form_fields: [{ type: 'text', label: 'Name', env_variable: name, default: 'other-app' }] })).toEqual([
        ['form_fields.0.env_variable', refused],
      ]);
    });

    it('can’t be a random field', () => {
      expect(issuesOf({ form_fields: [{ type: 'random', label: 'Name', env_variable: name }] })).toEqual([['form_fields.0.env_variable', refused]]);
    });

    it('can’t be an alias of a base URL field', () => {
      expect(
        issuesOf({
          form_fields: [{ type: 'app_base_url', label: 'Public URL', env_variable: 'APP_BASE_URL', alias_env_variables: ['APP_URL', name] }],
        }),
      ).toEqual([['form_fields.0.alias_env_variables.1', refused]]);
    });

    it('can’t be a Hub integration’s variable', () => {
      expect(
        issuesOf({
          hub_integration: {
            inference: { chat_model: name },
            inference_provider: { env: name, ollama: 'other-app', openai_compatible: 'other-app' },
            oidc: { issuer_env: name },
            memory: { url_env: name, token_env: name },
          },
        }),
      ).toEqual([
        ['hub_integration.inference.chat_model', refused],
        ['hub_integration.inference_provider.env', refused],
        ['hub_integration.oidc.issuer_env', refused],
        ['hub_integration.memory.url_env', refused],
        ['hub_integration.memory.token_env', refused],
      ]);
    });
  });

  it('still takes the base URL, the other Hub values and a field of the app’s own', () => {
    expect(
      issuesOf({
        form_fields: [
          { type: 'app_base_url', label: 'Public URL', env_variable: 'APP_BASE_URL', alias_env_variables: ['APP_URL', 'NEXTAUTH_URL'] },
          { type: 'text', label: 'Mail domain', env_variable: 'DOMAIN', required: true },
          { type: 'text', label: 'Site name', env_variable: 'APP_SITE_NAME', default: 'My app' },
          { type: 'random', label: 'Secret', env_variable: 'APP_SECRET' },
        ],
        hub_integration: { inference: { chat_model: 'LLM_MODEL' }, oidc: { issuer_env: 'OIDC_ISSUER' } },
      }),
    ).toEqual([]);
  });

  it('refuses names only as written: env names are case sensitive', () => {
    expect(issuesOf({ form_fields: [{ type: 'text', label: 'Name', env_variable: 'app_id' }] })).toEqual([]);
  });
});

/*
 * The Hub takes the host of APP_BASE_URL as one of the app's own hosts (APP_BASE_HOST), so the URL
 * is the operator's or the Hub's address for the app.
 */
describe('appInfoSchema: a field that writes APP_BASE_URL', () => {
  const refused = "A field that writes APP_BASE_URL can't have a default: the Hub gives the app its address";

  it.each([
    ['a base URL field', { type: 'app_base_url', label: 'Public URL', env_variable: 'APP_BASE_URL', default: 'https://other.example' }],
    ['a text field', { type: 'text', label: 'Public URL', env_variable: 'APP_BASE_URL', default: 'https://other.example' }],
    [
      'a base URL field with it as an alias',
      {
        type: 'app_base_url',
        label: 'Public URL',
        env_variable: 'SITE_URL',
        alias_env_variables: ['APP_BASE_URL'],
        default: 'https://other.example',
      },
    ],
  ])('can’t have a default: %s', (_kind, field) => {
    expect(issuesOf({ form_fields: [field] })).toEqual([['form_fields.0.default', refused]]);
  });

  it('may leave the default out, and another base URL field may have one', () => {
    expect(
      issuesOf({
        form_fields: [
          { type: 'app_base_url', label: 'Public URL', env_variable: 'APP_BASE_URL', default: '' },
          { type: 'app_base_url', label: 'Site URL', env_variable: 'SITE_URL', default: 'https://example.com' },
        ],
      }),
    ).toEqual([]);
  });
});
