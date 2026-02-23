/**
 * Common environment variable templates and port configurations for containerized apps
 * Based on industry standards from Olares, Tipi, and other app stores
 */

/**
 * Common default ports for various app types
 * These are suggested defaults that can be overridden
 */
export const COMMON_APP_PORTS = {
  // Web interfaces
  WEB_UI: 8080,
  WEB_UI_ALT: 8188,
  WEB_UI_ALT2: 3000,
  WEB_UI_ALT3: 8000,
  
  // Admin interfaces
  ADMIN_UI: 9000,
  ADMIN_UI_ALT: 9443,
  
  // API services
  API: 8081,
  API_ALT: 8082,
  
  // Database services
  POSTGRES: 5432,
  MYSQL: 3306,
  MONGODB: 27017,
  REDIS: 6379,
  
  // Message queues
  RABBITMQ: 5672,
  RABBITMQ_MGMT: 15672,
  KAFKA: 9092,
  
  // Other common services
  SSH: 22,
  FTP: 21,
  SMTP: 25,
  SMTP_TLS: 587,
  SMTP_SSL: 465,
  LDAP: 389,
  LDAPS: 636,
  
  // Media services
  PLEX: 32400,
  JELLYFIN: 8096,
  EMBY: 8096,
  
  // Development tools
  JUPYTER: 8888,
  VSCODE: 8443,
  GITEA: 3000,
  GITLAB: 8929,
} as const;

/**
 * Common environment variable defaults for containerized apps
 * These follow Linux/Docker best practices
 */
export const COMMON_ENV_DEFAULTS = {
  // User/Group IDs (standard non-root user)
  PUID: '1000',
  PGID: '1000',
  
  // Timezone (will be overridden with system timezone)
  TZ: 'Etc/UTC',
  
  // Common paths
  HOME: '/root',
  USER: 'root',
  
  // Cache and temporary directories
  CACHE_DIR: '/root/.cache',
  TEMP_DIR: '/tmp',
  TMP_DIR: '/tmp',
  
  // Python-specific
  PIP_CACHE_DIR: '/root/.cache/pip',
  PYTHONUNBUFFERED: '1',
  
  // Node.js-specific
  NPM_CONFIG_CACHE: '/root/.cache/npm',
  NODE_ENV: 'production',
  
  // Locale settings
  LANG: 'en_US.UTF-8',
  LANGUAGE: 'en_US:en',
  LC_ALL: 'en_US.UTF-8',
} as const;

/**
 * Database connection environment variable templates
 * These provide consistent naming across apps
 */
export const DATABASE_ENV_TEMPLATES = {
  POSTGRES: {
    DB_TYPE: 'postgres',
    DB_HOST: 'POSTGRES_HOST',
    DB_PORT: 'POSTGRES_PORT',
    DB_NAME: 'POSTGRES_DBNAME',
    DB_USER: 'POSTGRES_USERNAME',
    DB_PASSWORD: 'POSTGRES_PASSWORD',
  },
  MYSQL: {
    DB_TYPE: 'mysql',
    DB_HOST: 'MYSQL_HOST',
    DB_PORT: 'MYSQL_PORT',
    DB_NAME: 'MYSQL_DATABASE',
    DB_USER: 'MYSQL_USER',
    DB_PASSWORD: 'MYSQL_PASSWORD',
  },
  MONGODB: {
    DB_TYPE: 'mongodb',
    DB_HOST: 'MONGO_HOST',
    DB_PORT: 'MONGO_PORT',
    DB_NAME: 'MONGO_DATABASE',
    DB_USER: 'MONGO_USER',
    DB_PASSWORD: 'MONGO_PASSWORD',
  },
} as const;

/**
 * Common form field templates for reusable configuration
 * These can be used by apps to quickly add standard fields
 */
export const COMMON_FORM_FIELD_TEMPLATES = {
  TIMEZONE: {
    type: 'text' as const,
    label: 'Timezone',
    env_variable: 'TZ',
    default: 'Etc/UTC',
    placeholder: 'Etc/UTC',
    hint: 'Timezone for the application (e.g., America/New_York, Europe/London)',
  },
  
  USER_ID: {
    type: 'number' as const,
    label: 'User ID (PUID)',
    env_variable: 'PUID',
    default: 1000,
    hint: 'User ID for file permissions',
    min: 1,
    max: 65534,
  },
  
  GROUP_ID: {
    type: 'number' as const,
    label: 'Group ID (PGID)',
    env_variable: 'PGID',
    default: 1000,
    hint: 'Group ID for file permissions',
    min: 1,
    max: 65534,
  },
  
  DATABASE_NAME: {
    type: 'text' as const,
    label: 'Database Name',
    env_variable: 'DB_NAME',
    required: true,
    hint: 'Name of the database to use',
  },
  
  DATABASE_USER: {
    type: 'text' as const,
    label: 'Database Username',
    env_variable: 'DB_USER',
    required: true,
    hint: 'Username for database connection',
  },
  
  DATABASE_PASSWORD: {
    type: 'password' as const,
    label: 'Database Password',
    env_variable: 'DB_PASSWORD',
    required: true,
    hint: 'Password for database connection',
  },
  
  SECRET_KEY: {
    type: 'random' as const,
    label: 'Secret Key',
    env_variable: 'SECRET_KEY',
    encoding: 'hex' as const,
    min: 32,
    hint: 'Auto-generated secret key for encryption',
  },
  
  API_KEY: {
    type: 'random' as const,
    label: 'API Key',
    env_variable: 'API_KEY',
    encoding: 'hex' as const,
    min: 32,
    hint: 'Auto-generated API key',
  },
  
  ADMIN_EMAIL: {
    type: 'email' as const,
    label: 'Admin Email',
    env_variable: 'ADMIN_EMAIL',
    required: true,
    hint: 'Email address for the admin user',
  },
  
  ADMIN_USERNAME: {
    type: 'text' as const,
    label: 'Admin Username',
    env_variable: 'ADMIN_USERNAME',
    default: 'admin',
    hint: 'Username for the admin user',
  },
  
  ADMIN_PASSWORD: {
    type: 'password' as const,
    label: 'Admin Password',
    env_variable: 'ADMIN_PASSWORD',
    required: true,
    hint: 'Password for the admin user',
  },
  
  SMTP_HOST: {
    type: 'text' as const,
    label: 'SMTP Host',
    env_variable: 'SMTP_HOST',
    hint: 'SMTP server hostname for sending emails',
  },
  
  SMTP_PORT: {
    type: 'number' as const,
    label: 'SMTP Port',
    env_variable: 'SMTP_PORT',
    default: 587,
    hint: 'SMTP server port (usually 587 for TLS or 465 for SSL)',
    min: 1,
    max: 65535,
  },
  
  SMTP_USER: {
    type: 'text' as const,
    label: 'SMTP Username',
    env_variable: 'SMTP_USER',
    hint: 'Username for SMTP authentication',
  },
  
  SMTP_PASSWORD: {
    type: 'password' as const,
    label: 'SMTP Password',
    env_variable: 'SMTP_PASSWORD',
    hint: 'Password for SMTP authentication',
  },
  
  SMTP_FROM: {
    type: 'email' as const,
    label: 'From Email',
    env_variable: 'SMTP_FROM',
    hint: 'Email address to send from',
  },
} as const;

/**
 * Port range categories for different app types
 * Helps with port allocation strategy
 */
export const PORT_RANGE_CATEGORIES = {
  WEB_SERVICES: { min: 8000, max: 8999, description: 'Web UIs and HTTP services' },
  API_SERVICES: { min: 9000, max: 9999, description: 'API and REST services' },
  DATABASE_SERVICES: { min: 5000, max: 5999, description: 'Database services' },
  CUSTOM_SERVICES: { min: 10000, max: 60000, description: 'Custom application ports' },
} as const;

/**
 * App type to default port mapping
 * Suggests ports based on app category
 */
export const APP_CATEGORY_PORT_DEFAULTS: Record<string, number> = {
  media: COMMON_APP_PORTS.WEB_UI,
  development: COMMON_APP_PORTS.GITEA,
  ai: COMMON_APP_PORTS.WEB_UI_ALT,
  utilities: COMMON_APP_PORTS.WEB_UI,
  network: COMMON_APP_PORTS.WEB_UI,
  automation: COMMON_APP_PORTS.WEB_UI,
  social: COMMON_APP_PORTS.WEB_UI,
  photography: COMMON_APP_PORTS.WEB_UI,
  security: COMMON_APP_PORTS.WEB_UI,
  books: COMMON_APP_PORTS.WEB_UI,
  data: COMMON_APP_PORTS.WEB_UI,
  music: COMMON_APP_PORTS.WEB_UI,
  finance: COMMON_APP_PORTS.WEB_UI,
  gaming: COMMON_APP_PORTS.WEB_UI,
};
