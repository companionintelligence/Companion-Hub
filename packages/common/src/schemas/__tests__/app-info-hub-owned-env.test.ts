import { describe, expect, it } from 'vitest';
import { appInfoSchema, HUB_OWNED_APP_ENV_VARS, parseInstalledAppInfo } from '../app-info.js';

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
 * The Hub writes these into every app's env before the manifest's form fields. Its Traefik label
 * check and its sandbox take them as the app's own. A manifest that named one would replace
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

  it('may leave the default out and another base URL field may have one', () => {
    expect(
      issuesOf({
        form_fields: [
          { type: 'app_base_url', label: 'Public URL', env_variable: 'APP_BASE_URL', default: '' },
          { type: 'app_base_url', label: 'Site URL', env_variable: 'SITE_URL', default: 'https://example.com' },
        ],
      }),
    ).toEqual([]);
  });

  // Only a base URL field writes its aliases, so another field's alias is never APP_BASE_URL's value.
  it('lets a field of another type keep its default when it lists APP_BASE_URL as an alias', () => {
    expect(
      issuesOf({
        form_fields: [
          { type: 'text', label: 'Site URL', env_variable: 'SITE_URL', alias_env_variables: ['APP_BASE_URL'], default: 'https://example.com' },
        ],
      }),
    ).toEqual([]);
  });
});

/*
 * An installed app keeps the manifest it was installed with. One installed before these rules is
 * read with what they refuse left out, so the app keeps starting with the Hub's values.
 */
describe('parseInstalledAppInfo', () => {
  const installed = (input: Record<string, unknown>) => parseInstalledAppInfo({ ...baseApp, ...input });

  it('reads a manifest the rules refuse without the names they refuse', () => {
    const { parsed, leftOut } = installed({
      form_fields: [
        { type: 'text', label: 'Site name', env_variable: 'APP_NAME', default: 'Mine' },
        {
          type: 'app_base_url',
          label: 'Public URL',
          env_variable: 'APP_BASE_URL',
          alias_env_variables: ['APP_URL', 'APP_DOMAIN'],
          default: 'https://other.example',
        },
        { type: 'random', label: 'Secret', env_variable: 'APP_SECRET' },
      ],
      hub_integration: {
        inference: { chat_model: 'APP_ID', embedding_model: 'EMBED_MODEL' },
        inference_provider: { env: 'APP_DOMAIN', ollama: 'ollama', openai_compatible: 'openai' },
        oidc: { issuer_env: 'APP_URN' },
        memory: { url_env: 'APP_LOCAL_DOMAIN', token_env: 'MEMORY_TOKEN', url_style: 'api_base' },
      },
    });

    expect(parsed.success).toBe(true);
    const app = parsed.success ? parsed.data : undefined;
    expect(app?.form_fields.map((field) => [field.env_variable, field.alias_env_variables, field.default])).toEqual([
      ['APP_BASE_URL', ['APP_URL'], undefined],
      ['APP_SECRET', undefined, undefined],
    ]);
    expect(app?.hub_integration?.inference).toEqual({ embedding_model: 'EMBED_MODEL' });
    expect(app?.hub_integration?.inference_provider).toBeUndefined();
    expect(app?.hub_integration?.oidc).toBeUndefined();
    expect(app?.hub_integration?.memory).toEqual({ url_style: 'api_base' });
    expect(leftOut).toEqual([
      'form field APP_NAME',
      'alias APP_DOMAIN of form field APP_BASE_URL',
      'the default of form field APP_BASE_URL',
      'hub_integration.inference.chat_model (APP_ID)',
      'hub_integration.inference_provider (APP_DOMAIN)',
      'hub_integration.oidc (APP_URN)',
      'hub_integration.memory (APP_LOCAL_DOMAIN)',
    ]);
  });

  // An earlier env build wrote such a default into app.env, and the env builder drops a value that is
  // still it.
  it('says which defaults it left out of fields that write APP_BASE_URL', () => {
    const { baseUrlDefaults } = installed({
      form_fields: [
        { type: 'app_base_url', label: 'Public URL', env_variable: 'APP_BASE_URL', default: 'http://ci-hub.local/' },
        { type: 'app_base_url', label: 'Site URL', env_variable: 'SITE_URL', alias_env_variables: ['APP_BASE_URL'], default: 'https://site.example' },
        { type: 'app_base_url', label: 'Docs URL', env_variable: 'DOCS_URL', default: 'https://docs.example' },
        { type: 'text', label: 'Site name', env_variable: 'SITE_NAME', default: 'Mine' },
      ],
    });

    expect(baseUrlDefaults).toEqual({ APP_BASE_URL: 'http://ci-hub.local/', SITE_URL: 'https://site.example' });
    expect(installed({ form_fields: [{ type: 'app_base_url', label: 'Public URL', env_variable: 'APP_BASE_URL' }] }).baseUrlDefaults).toEqual({});
  });

  it('reads a manifest the rules accept as it is', () => {
    const input = {
      form_fields: [{ type: 'app_base_url', label: 'Public URL', env_variable: 'APP_BASE_URL', alias_env_variables: ['APP_URL'] }],
      hub_integration: { inference: { chat_model: 'LLM_MODEL' }, oidc: { issuer_env: 'OIDC_ISSUER' } },
    };
    const { parsed, leftOut } = installed(input);

    expect(leftOut).toEqual([]);
    expect(parsed.success && parsed.data).toEqual(appInfoSchema.parse({ ...baseApp, ...input }));
  });

  it('still refuses what is wrong for another reason', () => {
    expect(
      installed({
        form_fields: [
          { type: 'text', env_variable: 'APP_NAME' },
          { type: 'text', env_variable: 'SITE' },
        ],
      }).parsed.success,
    ).toBe(false);
  });
});
