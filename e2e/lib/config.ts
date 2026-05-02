/**
 * config.ts — Types and marketplace config loader.
 *
 * Mirrors the ci-marketplace app config schema. Single source of truth
 * for field types, defaults, and what the hub install form needs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// ─── Field schema (matches ci-marketplace config.json) ────────────────────────

export type FieldType = 'text' | 'password' | 'email' | 'url' | 'number' | 'boolean' | 'fqdnip' | 'random';

export interface FormField {
  type: FieldType;
  label: string;
  env_variable: string;
  required?: boolean;
  default?: string | boolean | number;
  placeholder?: string;
  hint?: string;
  min?: number;
  max?: number;
  options?: Array<{ label: string; value: string }>;
  regex?: string;
  pattern_error?: string;
}

export interface AppConfig {
  id: string;
  name: string;
  port?: number;
  version?: string;
  description?: string;
  short_desc?: string;
  exposable?: boolean;
  dynamic_config?: boolean;
  form_fields?: FormField[];
  categories?: string[];
  source?: string;
}

export interface DockerService {
  name: string;
  image: string;
  isMain?: boolean;
  internalPort?: number;
  environment?: Array<{ key: string; value: string }>;
  healthcheck?: {
    test?: string | string[];
    interval?: string;
    timeout?: string;
    retries?: number;
  };
  dependsOn?: Record<string, { condition: string }>;
  volumes?: string[];
}

export interface DockerCompose {
  schemaVersion?: number;
  services: DockerService[];
}

// ─── Loader ────────────────────────────────────────────────────────────────────

const MARKETPLACE_DIR = process.env.MARKETPLACE_DIR || path.resolve(__dirname, '../../../../ci-marketplace');

export function loadAppConfig(appId: string): AppConfig | null {
  const p = path.join(MARKETPLACE_DIR, 'apps', appId, 'config.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as AppConfig;
}

export function loadDockerCompose(appId: string): DockerCompose | null {
  const p = path.join(MARKETPLACE_DIR, 'apps', appId, 'docker-compose.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as DockerCompose;
}

/** Fuzzy-match an app name to a marketplace app id. */
export function resolveAppId(appName: string): string | null {
  const slug = appName.toLowerCase().replace(/\s+/g, '-');
  const appsDir = path.join(MARKETPLACE_DIR, 'apps');
  if (!fs.existsSync(appsDir)) return null;

  const apps = fs.readdirSync(appsDir);

  // Exact match first
  if (apps.includes(slug)) return slug;

  // Contains match
  const contains = apps.find((a) => a.includes(slug) || slug.includes(a));
  if (contains) return contains;

  // Config name match
  for (const app of apps) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(appsDir, app, 'config.json'), 'utf8'));
      if (cfg.name?.toLowerCase() === appName.toLowerCase()) return app;
    } catch {
      // skip unreadable config files
    }
  }

  return null;
}

// ─── Default value generator ───────────────────────────────────────────────────

/**
 * Given a form field, decide:
 *   - `value`      : the value to fill in
 *   - `showToUser` : whether this should be surfaced in the report as user-visible
 *   - `reason`     : why it was shown (required with no default, user-meaningful, etc.)
 */
export interface FieldResolution {
  field: FormField;
  value: string;
  showToUser: boolean;
  reason?: string;
}

export function resolveFieldValue(field: FormField): FieldResolution {
  // random fields: always generate, never show (they're infra secrets)
  if (field.type === 'random') {
    const len = field.min ?? 32;
    const value = crypto.randomBytes(len).toString('hex').slice(0, len);
    return { field, value, showToUser: false };
  }

  // If there's a sensible default that isn't a placeholder like "changeme", use it silently
  if (field.default !== undefined && field.default !== null && field.default !== '') {
    const d = String(field.default);
    const isWeak = /changeme|password|secret|example\.com|your[-_]?/i.test(d);
    const value = d;

    if (isWeak) {
      // Weak default — override with something better and show to user
      const better = betterDefault(field);
      return { field, value: better, showToUser: true, reason: 'Weak default overridden — review before production use' };
    }

    return { field, value, showToUser: false };
  }

  // No default — must generate and always show if not random
  if (field.required) {
    const generated = betterDefault(field);
    return {
      field,
      value: generated,
      showToUser: true,
      reason: 'Required field with no default — generated value used',
    };
  }

  // Optional with no default — generate silently if we can, skip otherwise
  const generated = betterDefault(field);
  if (generated) return { field, value: generated, showToUser: false };

  return { field, value: '', showToUser: false };
}

function betterDefault(field: FormField): string {
  const label = field.label.toLowerCase();
  const envVar = field.env_variable.toLowerCase();

  switch (field.type) {
    case 'email':
      return 'admin@ci.computer';
    case 'password':
      return generatePassword(field.min ?? 16);
    case 'boolean':
      return 'false';
    case 'number':
      return String(field.min ?? 1);
    case 'url':
      return field.placeholder || 'http://localhost:8080';
    case 'fqdnip':
      return field.placeholder || 'localhost';
    case 'text': {
      // Contextual text defaults
      if (/email/i.test(label + envVar)) return 'admin@ci.computer';
      if (/user(name)?/i.test(label + envVar)) return 'admin';
      if (/domain|host/i.test(label + envVar)) return 'ci.computer';
      if (/cron/i.test(label + envVar)) return field.placeholder || '@daily';
      if (/key|secret|token/i.test(label + envVar)) return generatePassword(32);
      return field.placeholder || (field.default as string) || '';
    }
    default:
      return '';
  }
}

function generatePassword(len: number): string {
  // Avoids $ which breaks env var interpolation in docker-compose
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#%^&*';
  return Array.from(crypto.randomBytes(len))
    .map((b) => chars[b % chars.length])
    .join('');
}

/** All fields that should be surfaced to the user in the report. */
export function getUserVisibleFields(fields: FormField[]): FieldResolution[] {
  return fields.map(resolveFieldValue).filter((r) => r.showToUser);
}

/** All resolved field values for filling the install form. */
export function resolveAllFields(fields: FormField[]): FieldResolution[] {
  return fields.map(resolveFieldValue);
}
