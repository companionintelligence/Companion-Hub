**@runtipi/common** 

This package contains the common tools used in the Runtipi project. It is a TypeScript package that provides type definitions and validation for various data structures used in the project.

## Features

- Type-safe schemas for app configurations using Zod and ArkType
- Common environment variable templates and defaults
- Port allocation templates and suggestions
- Form field templates for app configuration UI
- Database connection templates

## Usage

### Importing Templates

```typescript
import {
  COMMON_APP_PORTS,
  COMMON_ENV_DEFAULTS,
  COMMON_FORM_FIELD_TEMPLATES,
  DATABASE_ENV_TEMPLATES,
  PORT_RANGE_CATEGORIES,
  APP_CATEGORY_PORT_DEFAULTS,
} from '@runtipi/common/schemas';
```

### Using Port Templates

```typescript
const webPort = COMMON_APP_PORTS.WEB_UI; // 8080
const apiPort = COMMON_APP_PORTS.API; // 8081
```

### Using Form Field Templates

```typescript
const appFormFields = [
  COMMON_FORM_FIELD_TEMPLATES.TIMEZONE,
  COMMON_FORM_FIELD_TEMPLATES.USER_ID,
  COMMON_FORM_FIELD_TEMPLATES.SECRET_KEY,
];
```

### Using Environment Variable Defaults

```typescript
const defaultEnv = {
  PUID: COMMON_ENV_DEFAULTS.PUID, // '1000'
  PGID: COMMON_ENV_DEFAULTS.PGID, // '1000'
  TZ: COMMON_ENV_DEFAULTS.TZ, // 'Etc/UTC'
};
```

## Documentation

See [docs/app-templates.md](./docs/app-templates.md) for comprehensive documentation on all available templates, defaults, and usage examples.
