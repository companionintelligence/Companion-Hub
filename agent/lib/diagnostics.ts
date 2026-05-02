/**
 * diagnostics.ts
 *
 * AI-assisted diagnosis of E2E failures for ci-marketplace apps.
 * Knows about every failure category the explorer can produce and
 * maps them to concrete fixes in config.json or docker-compose.json.
 *
 * Failure categories:
 *   dns-timeout        → app URL never became reachable
 *   install-timeout    → app didn't reach running state within 3 min
 *   auth-failed        → couldn't sign up or log in to the app
 *   container-unhealthy→ docker container health check failing
 *   wrong-image        → image not found, deprecated, or wrong arch
 *   bad-env-var        → required env var missing, empty, or has bad default
 *   missing-required   → required config.json field has no usable default
 *   user-visible-var   → required user-facing variable has a weak/placeholder default
 */

import type { AppConfig, DockerCompose, FormField } from '../e2e/lib/config';

export interface DiagnosticContext {
  appId:           string;
  appName:         string;
  version?:        string;
  verdict:         string;
  issues:          string[];
  steps:           Record<string, any>;
  sessionErrors:   string[];
  userVisibleConfig: Array<{ label: string; env_variable: string; value: string; reason: string }>;
  config:          AppConfig;
  dockerCompose:   DockerCompose;
}

export interface Fix {
  file:    'config.json' | 'docker-compose.json';
  patch:   object;
  summary: string;
}

export interface DiagnosisResult {
  categories:   string[];
  diagnosis:    string;
  fix:          Fix | null;
  confidence:   'high' | 'medium' | 'low';
  suggestions:  string[];   // human-readable notes for the PR description
}

// ─── Local heuristics (no API call needed for these) ─────────────────────────

function detectCategories(ctx: DiagnosticContext): string[] {
  const cats = new Set<string>();

  if (ctx.verdict === 'dns-timeout')                       cats.add('dns-timeout');
  if (ctx.steps.install?.status === 'timeout')             cats.add('install-timeout');
  if (ctx.steps.auth?.method === 'failed')                 cats.add('auth-failed');
  if (ctx.userVisibleConfig.some(f => f.reason?.includes('Required'))) cats.add('missing-required');
  if (ctx.userVisibleConfig.some(f => f.reason?.includes('Weak')))     cats.add('user-visible-var');

  const errors = [...ctx.issues, ...ctx.sessionErrors].join(' ').toLowerCase();
  if (/unhealthy|health.?check|container.*(exit|restart|crash)/i.test(errors)) cats.add('container-unhealthy');
  if (/not found|pull.*error|no such image|manifest unknown|403/i.test(errors))  cats.add('wrong-image');
  if (/env.*missing|required.*variable|undefined.*env/i.test(errors))           cats.add('bad-env-var');

  return Array.from(cats);
}

/** Find form fields that have no usable default and are required. */
function findProblematicFields(config: AppConfig): FormField[] {
  const problematic: FormField[] = [];
  for (const f of config.form_fields ?? []) {
    if (f.type === 'random') continue; // always auto-generated, never a problem
    if (f.required && (f.default === undefined || f.default === '' || f.default === null)) {
      problematic.push(f);
    }
  }
  return problematic;
}

/** Find docker services with no healthcheck defined. */
function findUnhealthyServices(compose: DockerCompose): string[] {
  return compose.services
    .filter(s => s.isMain && !s.healthcheck)
    .map(s => s.name);
}

/** Find env vars in docker-compose that reference form fields with bad defaults. */
function findBadEnvVars(config: AppConfig, compose: DockerCompose): Array<{ service: string; key: string; value: string }> {
  const badDefaults = new Set(
    (config.form_fields ?? [])
      .filter(f => f.default !== undefined && /changeme|password|secret|example\.com/i.test(String(f.default)))
      .map(f => f.env_variable)
  );

  const results: Array<{ service: string; key: string; value: string }> = [];
  for (const svc of compose.services) {
    for (const env of svc.environment ?? []) {
      if (/changeme|password123|secret|todo|fixme/i.test(env.value)) {
        results.push({ service: svc.name, key: env.key, value: env.value });
      }
    }
  }
  return results;
}

// ─── Config.json patch helpers ────────────────────────────────────────────────

function patchConfigFields(config: AppConfig, overrides: Array<{ env_variable: string; default: string }>): AppConfig {
  const patched = structuredClone(config) as AppConfig;
  for (const override of overrides) {
    const field = (patched.form_fields ?? []).find(f => f.env_variable === override.env_variable);
    if (field) field.default = override.default;
  }
  return patched;
}

function addHealthcheck(compose: DockerCompose, serviceName: string): DockerCompose {
  const patched = structuredClone(compose) as DockerCompose;
  const svc = patched.services.find(s => s.name === serviceName);
  if (svc) {
    svc.healthcheck = {
      test:     ['CMD-SHELL', 'wget -qO- http://localhost/health || curl -f http://localhost/health || exit 1'],
      interval: '30s',
      timeout:  '10s',
      retries:  5,
    };
  }
  return patched;
}

// ─── AI diagnosis ─────────────────────────────────────────────────────────────

export async function diagnose(ctx: DiagnosticContext): Promise<DiagnosisResult> {
  const categories  = detectCategories(ctx);
  const badFields   = findProblematicFields(ctx.config);
  const badServices = findUnhealthyServices(ctx.dockerCompose);
  const badEnvVars  = findBadEnvVars(ctx.config, ctx.dockerCompose);
  const suggestions: string[] = [];

  // ── High-confidence local fixes (no AI needed) ──

  // Missing required fields with no defaults → add sensible defaults to config.json
  if (categories.includes('missing-required') && badFields.length) {
    const overrides = badFields.map(f => ({
      env_variable: f.env_variable,
      default:      f.type === 'email' ? 'admin@ci.computer'
                  : f.type === 'password' ? 'ChangeMe123!'
                  : f.placeholder ?? 'default-value',
    }));
    const patched = patchConfigFields(ctx.config, overrides);
    suggestions.push(`Added sensible defaults for ${badFields.length} required field(s): ${badFields.map(f => f.label).join(', ')}`);
    suggestions.push(`⚠️ User-visible fields need review: ${ctx.userVisibleConfig.map(f => f.label).join(', ')}`);
    return {
      categories,
      diagnosis: `${badFields.length} required form field(s) have no default, causing install to fail silently or require user input the hub UI may not surface properly.`,
      fix:        { file: 'config.json', patch: patched, summary: `Add defaults for: ${badFields.map(f => f.env_variable).join(', ')}` },
      confidence: 'high',
      suggestions,
    };
  }

  // No healthcheck on main service → add one
  if (categories.includes('container-unhealthy') && badServices.length) {
    let patched = structuredClone(ctx.dockerCompose) as DockerCompose;
    for (const svc of badServices) patched = addHealthcheck(patched, svc);
    suggestions.push(`Added healthcheck to service(s): ${badServices.join(', ')}`);
    return {
      categories,
      diagnosis: `Main service(s) [${badServices.join(', ')}] have no healthcheck. The hub may never mark the app as running.`,
      fix:        { file: 'docker-compose.json', patch: patched, summary: 'Add healthcheck to main service' },
      confidence: 'high',
      suggestions,
    };
  }

  // ── AI diagnosis for complex / ambiguous cases ──
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      categories,
      diagnosis:   'No OPENAI_API_KEY — local heuristics did not find a clear fix.',
      fix:         null,
      confidence:  'low',
      suggestions: ['Set OPENAI_API_KEY to enable AI-assisted diagnosis'],
    };
  }

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });

  const prompt = `You are a Docker Compose and self-hosted app configuration expert.

The E2E test for app "${ctx.appName}" (id: ${ctx.appId}, version: ${ctx.version ?? 'unknown'}) failed.

## Failure categories detected
${categories.join(', ') || 'none'}

## Issues reported
${ctx.issues.join('\n') || 'none'}

## Session errors (last 20)
${ctx.sessionErrors.slice(0, 20).join('\n') || 'none'}

## User-visible config fields (generated by explorer — may be wrong)
${JSON.stringify(ctx.userVisibleConfig, null, 2)}

## Test steps
${JSON.stringify(ctx.steps, null, 2)}

## config.json
${JSON.stringify(ctx.config, null, 2)}

## docker-compose.json
${JSON.stringify(ctx.dockerCompose, null, 2)}

## Common culprits
- config.json form_fields missing sensible defaults (especially required fields)
- Weak defaults like "changeme" or "password" that should be flagged as user-visible
- Wrong or outdated container image tags
- Missing healthcheck causing hub to never mark app as running
- Environment variable mismatch between config.json form_fields and docker-compose.json
- Container port mismatch (internalPort vs actual app port)
- Missing required env vars in docker-compose that aren't in form_fields
- Architecture issues (arm64 vs amd64 image tags)

Diagnose the most likely root cause. Suggest ONE specific, minimal fix.

Respond with JSON:
{
  "categories": ["..."],
  "diagnosis": "paragraph explaining root cause",
  "confidence": "high|medium|low",
  "suggestions": ["human-readable note for PR", "..."],
  "fix": {
    "file": "config.json" | "docker-compose.json",
    "patch": { ...complete fixed JSON object... },
    "summary": "one-line summary of what changed"
  }
}
If no fix can be determined, set "fix": null.`;

  const response = await client.chat.completions.create({
    model:           'gpt-4o',
    max_tokens:      3000,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }],
  });

  const result = JSON.parse(response.choices[0].message.content || '{}') as DiagnosisResult;

  // Merge locally-detected categories
  result.categories = Array.from(new Set([...categories, ...(result.categories ?? [])]));
  result.suggestions = [...suggestions, ...(result.suggestions ?? [])];

  return result;
}
