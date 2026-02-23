import { dynamicComposeSchema, serviceSchema, MIN_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION } from './dynamic-compose.js';
import { parseComposeJson } from './utils/convert-legacy-schema.js';
import type { DependsOn, DynamicCompose, Service, ServiceInput } from './dynamic-compose.js';
import { dynamicComposeSchemaArk, serviceSchemaArk } from './dynamic-compose-ark.js';

import {
  APP_CATEGORIES,
  ARCHITECTURES,
  FIELD_TYPES,
  RANDOM_ENCODINGS,
  appInfoSchema,
  formFieldSchema,
  appInfoSchemaArk,
  formFieldSchemaArk,
  frontmatterSchema,
} from './app-info.js';
import type { AppCategory, AppInfo, AppInfoInput, FieldType, FormField, RandomEncoding } from './app-info.js';

import { type SSE, type Topic, sseSchema } from './sse.js';

import { toJsonSchema } from './utils/to-json-schema.js';

import {
  COMMON_APP_PORTS,
  COMMON_ENV_DEFAULTS,
  DATABASE_ENV_TEMPLATES,
  COMMON_FORM_FIELD_TEMPLATES,
  PORT_RANGE_CATEGORIES,
  APP_CATEGORY_PORT_DEFAULTS,
} from './app-templates.js';

export {
  dynamicComposeSchema,
  dynamicComposeSchemaArk,
  serviceSchemaArk,
  parseComposeJson,
  serviceSchema,
  toJsonSchema,
  MIN_SCHEMA_VERSION,
  CURRENT_SCHEMA_VERSION,
  APP_CATEGORIES,
  formFieldSchema,
  formFieldSchemaArk,
  RANDOM_ENCODINGS,
  FIELD_TYPES,
  ARCHITECTURES,
  appInfoSchema,
  appInfoSchemaArk,
  sseSchema,
  frontmatterSchema,
  COMMON_APP_PORTS,
  COMMON_ENV_DEFAULTS,
  DATABASE_ENV_TEMPLATES,
  COMMON_FORM_FIELD_TEMPLATES,
  PORT_RANGE_CATEGORIES,
  APP_CATEGORY_PORT_DEFAULTS,
  type ServiceInput,
  type DependsOn,
  type Service,
  type DynamicCompose,
  type AppInfo,
  type AppInfoInput,
  type FormField,
  type FieldType,
  type RandomEncoding,
  type AppCategory,
  type SSE,
  type Topic,
};
