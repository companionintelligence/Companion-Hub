# App Templates and Default Environment Variables

This document describes the common app templates, port configurations, and environment variable defaults available in CI-OS-Hub.

## Overview

CI-OS-Hub provides a comprehensive set of templates and defaults to make containerized app configuration easier and more consistent. These templates follow industry best practices from systems like Olares, Tipi, and other app stores.

## Common Environment Variables

### Standard Linux/Docker Defaults

The following environment variables are automatically added to all apps if not already specified:

| Variable | Default Value | Description |
|----------|---------------|-------------|
| `PUID` | `1000` | Process User ID for file permissions |
| `PGID` | `1000` | Process Group ID for file permissions |
| `TZ` | `Etc/UTC` | Timezone (overridden with system timezone) |

### Additional Common Variables

These variables can be used in app configurations:

| Variable | Default Value | Description |
|----------|---------------|-------------|
| `HOME` | `/root` | Home directory path |
| `USER` | `root` | Username |
| `CACHE_DIR` | `/root/.cache` | General cache directory |
| `TEMP_DIR` | `/tmp` | Temporary directory |
| `TMP_DIR` | `/tmp` | Alternative temp directory |

### Python-Specific Variables

| Variable | Default Value | Description |
|----------|---------------|-------------|
| `PIP_CACHE_DIR` | `/root/.cache/pip` | Pip package cache |
| `PYTHONUNBUFFERED` | `1` | Disable Python output buffering |

### Node.js-Specific Variables

| Variable | Default Value | Description |
|----------|---------------|-------------|
| `NPM_CONFIG_CACHE` | `/root/.cache/npm` | NPM package cache |
| `NODE_ENV` | `production` | Node environment |

### Locale Settings

| Variable | Default Value | Description |
|----------|---------------|-------------|
| `LANG` | `en_US.UTF-8` | Language setting |
| `LANGUAGE` | `en_US:en` | Language list |
| `LC_ALL` | `en_US.UTF-8` | Locale setting |

## Common Port Defaults

### Web Interfaces

| Port | Service Type | Description |
|------|-------------|-------------|
| 8080 | Primary Web UI | Default web interface port |
| 8188 | Alternate Web UI | Alternative web interface |
| 3000 | Alternate Web UI | Common development port |
| 8000 | Alternate Web UI | Another common web port |

### Admin Interfaces

| Port | Service Type | Description |
|------|-------------|-------------|
| 9000 | Admin UI | Primary admin interface |
| 9443 | Admin UI (HTTPS) | Secure admin interface |

### API Services

| Port | Service Type | Description |
|------|-------------|-------------|
| 8081 | API | Primary API endpoint |
| 8082 | API Alternate | Secondary API endpoint |

### Database Services

| Port | Service Type | Description |
|------|-------------|-------------|
| 5432 | PostgreSQL | PostgreSQL database |
| 3306 | MySQL | MySQL/MariaDB database |
| 27017 | MongoDB | MongoDB database |
| 6379 | Redis | Redis cache/database |

### Message Queues

| Port | Service Type | Description |
|------|-------------|-------------|
| 5672 | RabbitMQ | RabbitMQ AMQP |
| 15672 | RabbitMQ Management | RabbitMQ admin UI |
| 9092 | Kafka | Apache Kafka |

### Other Common Services

| Port | Service Type | Description |
|------|-------------|-------------|
| 22 | SSH | Secure Shell |
| 21 | FTP | File Transfer Protocol |
| 25 | SMTP | Email (plain) |
| 587 | SMTP TLS | Email with TLS |
| 465 | SMTP SSL | Email with SSL |
| 389 | LDAP | LDAP directory |
| 636 | LDAPS | LDAP over SSL |

### Popular Media Apps

| Port | Service Type | Description |
|------|-------------|-------------|
| 32400 | Plex | Plex Media Server |
| 8096 | Jellyfin/Emby | Media server |

### Development Tools

| Port | Service Type | Description |
|------|-------------|-------------|
| 8888 | Jupyter | Jupyter Notebook |
| 8443 | VS Code | VS Code Server |
| 3000 | Gitea | Gitea Git server |
| 8929 | GitLab | GitLab |

## Port Allocation Strategy

### Port Ranges by Category

| Range | Category | Description |
|-------|----------|-------------|
| 8000-8999 | Web Services | Web UIs and HTTP services |
| 9000-9999 | API Services | API and REST services |
| 5000-5999 | Database Services | Database services |
| 10000-60000 | Custom Services | Dynamic allocation range |

### Port Suggestion by App Category

When allocating ports, the system suggests defaults based on app category:

| App Category | Suggested Port |
|--------------|----------------|
| Media | 8080 |
| Development | 3000 |
| AI | 8188 |
| Utilities | 8080 |
| Network | 8080 |
| Automation | 8080 |
| Social | 8080 |
| Photography | 8080 |
| Security | 8080 |
| Books | 8080 |
| Data | 8080 |
| Music | 8080 |
| Finance | 8080 |
| Gaming | 8080 |

## Form Field Templates

### Common Reusable Form Fields

The following pre-configured form field templates are available for apps:

#### Timezone

```typescript
{
  type: 'text',
  label: 'Timezone',
  env_variable: 'TZ',
  default: 'Etc/UTC',
  placeholder: 'Etc/UTC',
  hint: 'Timezone for the application (e.g., America/New_York, Europe/London)'
}
```

#### User and Group IDs

```typescript
{
  type: 'number',
  label: 'User ID (PUID)',
  env_variable: 'PUID',
  default: 1000,
  hint: 'User ID for file permissions',
  min: 1,
  max: 65534
}
```

#### Database Configuration

```typescript
{
  type: 'text',
  label: 'Database Name',
  env_variable: 'DB_NAME',
  required: true,
  hint: 'Name of the database to use'
}
```

#### Security Keys

```typescript
{
  type: 'random',
  label: 'Secret Key',
  env_variable: 'SECRET_KEY',
  encoding: 'hex',
  min: 32,
  hint: 'Auto-generated secret key for encryption'
}
```

#### Admin Credentials

```typescript
{
  type: 'email',
  label: 'Admin Email',
  env_variable: 'ADMIN_EMAIL',
  required: true,
  hint: 'Email address for the admin user'
}
```

#### SMTP Configuration

```typescript
{
  type: 'text',
  label: 'SMTP Host',
  env_variable: 'SMTP_HOST',
  hint: 'SMTP server hostname for sending emails'
}
```

## Database Connection Templates

### PostgreSQL

```typescript
{
  DB_TYPE: 'postgres',
  DB_HOST: 'POSTGRES_HOST',
  DB_PORT: 'POSTGRES_PORT',
  DB_NAME: 'POSTGRES_DBNAME',
  DB_USER: 'POSTGRES_USERNAME',
  DB_PASSWORD: 'POSTGRES_PASSWORD'
}
```

### MySQL

```typescript
{
  DB_TYPE: 'mysql',
  DB_HOST: 'MYSQL_HOST',
  DB_PORT: 'MYSQL_PORT',
  DB_NAME: 'MYSQL_DATABASE',
  DB_USER: 'MYSQL_USER',
  DB_PASSWORD: 'MYSQL_PASSWORD'
}
```

### MongoDB

```typescript
{
  DB_TYPE: 'mongodb',
  DB_HOST: 'MONGO_HOST',
  DB_PORT: 'MONGO_PORT',
  DB_NAME: 'MONGO_DATABASE',
  DB_USER: 'MONGO_USER',
  DB_PASSWORD: 'MONGO_PASSWORD'
}
```

## Usage Examples

### Using Templates in App Configuration

```typescript
import { 
  COMMON_FORM_FIELD_TEMPLATES,
  COMMON_APP_PORTS,
  DATABASE_ENV_TEMPLATES 
} from '@runtipi/common/schemas';

const appConfig = {
  name: 'my-app',
  port: COMMON_APP_PORTS.WEB_UI, // 8080
  form_fields: [
    COMMON_FORM_FIELD_TEMPLATES.TIMEZONE,
    COMMON_FORM_FIELD_TEMPLATES.USER_ID,
    COMMON_FORM_FIELD_TEMPLATES.GROUP_ID,
    COMMON_FORM_FIELD_TEMPLATES.DATABASE_NAME,
    COMMON_FORM_FIELD_TEMPLATES.SECRET_KEY,
  ]
};
```

### Port Allocation with Suggestions

```typescript
// In port manager service
await portManager.allocatePorts(appUrn, [
  {
    containerPort: 8080,
    label: 'main',
    suggestFromCommon: true, // Will suggest 8080 for 'main' label
  },
  {
    containerPort: 9000,
    label: 'admin',
    suggestFromCommon: true, // Will suggest 9000 for 'admin' label
  }
]);
```

## Benefits

1. **Consistency**: All apps follow the same conventions for common variables
2. **Reduced Configuration**: Less boilerplate for app developers
3. **Best Practices**: Based on industry standards from Olares, Tipi, and Docker
4. **Type Safety**: All templates are fully typed with TypeScript
5. **Flexibility**: Templates can be customized or overridden as needed
6. **Documentation**: Clear documentation for all defaults and templates

## References

- [Olares App Store](https://github.com/beclab/apps)
- [Docker Best Practices](https://docs.docker.com/develop/dev-best-practices/)
- [Twelve-Factor App](https://12factor.net/)
