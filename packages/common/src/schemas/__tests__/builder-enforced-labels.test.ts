/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: compose expansions, written as a manifest writes them */
import { describe, expect, it } from 'vitest';
import { BUILDER_ENFORCED_LABEL_REFUSALS, isBuilderEnforcedLabelIssue, safeParseKeepingBuilderEnforcedLabels } from '../builder-enforced-labels';
import { dynamicComposeFormSchema } from '../dynamic-compose';
import { collectTraefikLabelIssues, TRAEFIK_LABEL_REFUSALS } from '../traefik-labels';
import { parseComposeJson, parseInstalledComposeJson } from '../utils/convert-legacy-schema';

const web = (extra: Record<string, unknown> = {}) => ({ name: 'web', image: 'nginx:1.27-alpine', isMain: true, internalPort: 80, ...extra });

/** Labels an app saved before the label rules may hold: a Traefik option of its own and the Hub's own label. */
const OLD_LABELS = {
  'com.example.team': 'web',
  'traefik.docker.network': 'ci-hub_network',
  'traefik.http.routers.web.entrypoints': 'web',
  'ci-hub.appurn': 'other-app:ci-marketplace',
};

const refusals = (run: () => unknown): string[] => {
  try {
    run();
  } catch (error) {
    return [...String((error as Error).message).matchAll(/"message": "([A-Z_]+)"/g)].map((match) => match[1] as string);
  }
  return [];
};

describe('BUILDER_ENFORCED_LABEL_REFUSALS', () => {
  it('names every refusal the Traefik label check gives', () => {
    const issues = collectTraefikLabelIssues({
      'traefik.tcp.routers.{{CI_HUB_APP_ID}}.rule': 'HostSNI(`*`)',
      'traefik.http.routers.web.rule': 'Host(`${APP_DOMAIN}`)',
      'traefik.http.routers.{{CI_HUB_APP_ID}}-a.service': 'another-app-ci-marketplace',
      'traefik.http.routers.{{CI_HUB_APP_ID}}-b.middlewares': 'another-app-ci-marketplace-auth@docker',
      'traefik.http.routers.{{CI_HUB_APP_ID}}-c.rule': 'PathPrefix(`/`)',
    });

    expect(new Set(issues.map((issue) => issue.message))).toEqual(TRAEFIK_LABEL_REFUSALS);
    for (const message of TRAEFIK_LABEL_REFUSALS) {
      expect(BUILDER_ENFORCED_LABEL_REFUSALS).toContain(message);
    }
    expect(BUILDER_ENFORCED_LABEL_REFUSALS).toContain('CUSTOM_APP_ERROR_LABEL_RESERVED');
    expect(BUILDER_ENFORCED_LABEL_REFUSALS).not.toContain('CUSTOM_APP_ERROR_PRIVILEGED_NOT_ALLOWED');
  });

  it('forgives a label refusal only where it names an extraLabels key', () => {
    expect(isBuilderEnforcedLabelIssue({ message: 'CUSTOM_APP_ERROR_LABEL_RESERVED', path: ['services', 0, 'extraLabels', 'ci-hub.appurn'] })).toBe(
      true,
    );
    expect(isBuilderEnforcedLabelIssue({ message: 'CUSTOM_APP_ERROR_LABEL_RESERVED', path: ['services', 0, 'environment', 'ci-hub.appurn'] })).toBe(
      false,
    );
    expect(isBuilderEnforcedLabelIssue({ message: 'CUSTOM_APP_ERROR_PRIVILEGED_NOT_ALLOWED', path: ['services', 0, 'extraLabels', 'x'] })).toBe(
      false,
    );
  });
});

describe('parseInstalledComposeJson', () => {
  it('reads an installed compose whose labels the builder leaves out, with the labels as stored', () => {
    const compose = { schemaVersion: 2, services: [web({ extraLabels: OLD_LABELS })] };
    const stored = JSON.stringify(compose);

    expect(refusals(() => parseComposeJson(compose))).toEqual(
      expect.arrayContaining([
        'CUSTOM_APP_ERROR_LABEL_RESERVED',
        'CUSTOM_APP_ERROR_TRAEFIK_LABEL_NOT_ALLOWED',
        'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN',
      ]),
    );

    const parsed = parseInstalledComposeJson(compose);

    // In the stored order: the builder sees the same labels it did before the rule.
    expect(Object.entries(parsed.services[0]?.extraLabels ?? {})).toEqual(Object.entries(OLD_LABELS));
    expect(parsed.services[0]).toMatchObject({ name: 'web', image: 'nginx:1.27-alpine', isMain: true });
    expect(JSON.stringify(compose)).toBe(stored);
  });

  it('reads the labels of an override the same way', () => {
    const compose = {
      schemaVersion: 2,
      services: [web({ extraLabels: { 'traefik.docker.network': 'ci-hub_network' } })],
      overrides: [{ architecture: 'arm64', services: [{ name: 'web', extraLabels: { 'traefik.http.routers.web.entrypoints': 'web' } }] }],
    };

    const parsed = parseInstalledComposeJson(compose);

    expect(parsed.overrides?.[0]?.services[0]?.extraLabels).toEqual({ 'traefik.http.routers.web.entrypoints': 'web' });
  });

  it.each([
    ['a privileged service', { schemaVersion: 2, services: [web({ privileged: true })] }],
    ['a privileged service that also has a refused label', { schemaVersion: 2, services: [web({ privileged: true, extraLabels: OLD_LABELS })] }],
    [
      'a privileged override beside a refused label',
      { schemaVersion: 2, services: [web({ extraLabels: OLD_LABELS })], overrides: [{ services: [{ name: 'web', privileged: true }] }] },
    ],
    [
      'a denied host path beside a refused label',
      { schemaVersion: 2, services: [web({ extraLabels: OLD_LABELS, volumes: [{ hostPath: '/etc', containerPath: '/x' }] })] },
    ],
  ])('still refuses %s', (_name, compose) => {
    expect(refusals(() => parseInstalledComposeJson(compose))).not.toEqual([]);
    expect(refusals(() => parseInstalledComposeJson(compose))).toEqual(expect.arrayContaining([expect.not.stringMatching(/LABEL|TRAEFIK/)]));
  });

  it('refuses a privileged service with the same refusal parseComposeJson gives', () => {
    const compose = { schemaVersion: 2, services: [web({ privileged: true })] };

    expect(() => parseInstalledComposeJson(compose)).toThrow('CUSTOM_APP_ERROR_PRIVILEGED_NOT_ALLOWED');
    expect(refusals(() => parseInstalledComposeJson(compose))).toEqual(refusals(() => parseComposeJson(compose)));
  });
});

describe('safeParseKeepingBuilderEnforcedLabels', () => {
  it('hands the editor the label refusals it forgave, where each one is', () => {
    const result = safeParseKeepingBuilderEnforcedLabels(dynamicComposeFormSchema, { services: [web({ extraLabels: OLD_LABELS })] });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.labelIssues.map((issue) => [issue.message, issue.path])).toEqual(
      expect.arrayContaining([
        ['CUSTOM_APP_ERROR_LABEL_RESERVED', ['services', 0, 'extraLabels', 'ci-hub.appurn']],
        ['CUSTOM_APP_ERROR_TRAEFIK_LABEL_NOT_ALLOWED', ['services', 0, 'extraLabels', 'traefik.docker.network']],
        ['CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN', ['services', 0, 'extraLabels', 'traefik.http.routers.web.entrypoints']],
      ]),
    );
    expect(result.data.services[0]?.extraLabels).toEqual(OLD_LABELS);
  });

  it('reports nothing for a compose that breaks no rule', () => {
    const result = safeParseKeepingBuilderEnforcedLabels(dynamicComposeFormSchema, {
      services: [web({ extraLabels: { 'com.example.team': 'web' } })],
    });

    expect(result).toMatchObject({ success: true, labelIssues: [] });
  });
});
