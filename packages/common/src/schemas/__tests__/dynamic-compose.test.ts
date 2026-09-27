import { describe, it, expect } from 'vitest';

import {
  serviceSchema as serviceSchemaZod,
  dynamicComposeSchema as dynamicComposeSchemaZod,
  dynamicComposeObject,
  dynamicComposeFormSchema,
  collectServiceSecurityViolations,
  TRUSTED_APP_SECURITY_ALLOWLIST,
} from '../dynamic-compose.js';
import type { ZodAny } from 'zod';

type ValidationResult<T> = { success: true; data: T } | { success: false };

function safeParseZod<T>(schema: ZodAny, data: unknown): ValidationResult<T> {
  const result = schema.safeParse(data);
  return result.success ? { success: true, data: result.data } : { success: false };
}

const schemas = [{ name: 'Zod', serviceSchema: serviceSchemaZod, dynamicComposeSchema: dynamicComposeSchemaZod, safeParse: safeParseZod }];

schemas.forEach(({ name, serviceSchema, dynamicComposeSchema, safeParse }) => {
  describe(`DynamicCompose Schema Tests with ${name}`, () => {
    describe('Service Schema V2', () => {
      describe('Required Fields', () => {
        it('should validate minimal valid service', () => {
          const service = {
            image: 'nginx:latest',
            name: 'web-server',
            internalPort: 80,
          };

          const result = safeParse(serviceSchema, service);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.data).toMatchInlineSnapshot(`
              {
                "image": "nginx:latest",
                "internalPort": 80,
                "name": "web-server",
              }
            `);
          }
        });

        it('should require image field', () => {
          const service = {
            name: 'web-server',
            internalPort: 80,
          };

          const result = safeParse(serviceSchema, service);
          expect(result.success).toBe(false);
        });

        it('should require name field', () => {
          const service = {
            image: 'nginx:latest',
            internalPort: 80,
          };

          const result = safeParse(serviceSchema, service);
          expect(result.success).toBe(false);
        });

        it('should not require internalPort field', () => {
          const service = {
            image: 'nginx:latest',
            name: 'web-server',
          };

          const result = safeParse(serviceSchema, service);
          expect(result.success).toBe(true);
        });
      });

      describe('Port Validation', () => {
        it('should validate port range 1-65535', () => {
          const validPorts = [1, 80, 443, 9091, 65535];

          for (const port of validPorts) {
            const service = {
              image: 'nginx:latest',
              name: 'web-server',
              internalPort: port,
            };

            const result = safeParse(serviceSchema, service);
            expect(result.success).toBe(true);
          }
        });

        it('should reject invalid port numbers', () => {
          const invalidPorts = [0, -1, 65536, 70000];

          for (const port of invalidPorts) {
            const service = {
              image: 'nginx:latest',
              name: 'web-server',
              internalPort: port,
            };

            const result = safeParse(serviceSchema, service);
            expect(result.success).toBe(false);
          }
        });
      });

      describe('Environment Variables', () => {
        it('should validate valid environment variables', () => {
          const service = {
            image: 'nginx:latest',
            name: 'web-server',
            internalPort: 80,
            environment: [
              { key: 'NODE_ENV', value: 'production' },
              { key: 'PORT', value: '9091' },
              { key: 'DB_HOST', value: 'localhost' },
            ],
          };

          const result = safeParse(serviceSchema, service);
          expect(result.success).toBe(true);
        });

        it('should reject empty environment key', () => {
          const service = {
            image: 'nginx:latest',
            name: 'web-server',
            internalPort: 80,
            environment: [{ key: '', value: 'production' }],
          };

          const result = safeParse(serviceSchema, service);
          expect(result.success).toBe(false);
        });

        it('should reject empty environment value', () => {
          const service = {
            image: 'nginx:latest',
            name: 'web-server',
            internalPort: 80,
            environment: [{ key: 'NODE_ENV', value: '' }],
          };

          const result = safeParse(serviceSchema, service);
          expect(result.success).toBe(false);
        });
      });

      describe('Volumes Configuration', () => {
        it('should validate volumes with all options', () => {
          const service = {
            image: 'nginx:latest',
            name: 'web-server',
            internalPort: 80,
            volumes: [
              {
                hostPath: '/host/path',
                containerPath: '/container/path',
                type: 'bind' as const,
                readOnly: true,
              },
            ],
          };

          const result = safeParse(serviceSchema, service);
          expect(result.success).toBe(true);
        });

        it('should require hostPath and containerPath', () => {
          const service = {
            image: 'nginx:latest',
            name: 'web-server',
            internalPort: 80,
            volumes: [
              {
                type: 'bind' as const,
              },
            ],
          };

          const result = safeParse(serviceSchema, service);
          expect(result.success).toBe(false);
        });

        const withVolume = (volume: Record<string, unknown>) => ({
          image: 'postgres:18',
          name: 'database',
          volumes: [volume],
        });

        it('should accept a named volume in place of a host path', () => {
          const result = safeParse(serviceSchema, withVolume({ volumeName: 'pgdata', containerPath: '/var/lib/postgresql' }));
          expect(result.success).toBe(true);
        });

        it('should reject a volume that declares both a host path and a named volume', () => {
          const result = safeParse(serviceSchema, withVolume({ hostPath: '/host/path', volumeName: 'pgdata', containerPath: '/var/lib/postgresql' }));
          expect(result.success).toBe(false);
        });

        // The message is asserted, not just the failure: naming only the bind mount would point an
        // author who meant to declare a named volume at a field that is no longer the only option.
        it('should reject a volume that declares no source, naming both sources in the error', () => {
          // Parsed directly rather than through `safeParse`, which drops the issue list.
          const result = serviceSchema.safeParse(withVolume({ containerPath: '/var/lib/postgresql' }));
          expect(result.success).toBe(false);
          expect(result.error?.issues.map((issue) => issue.message)).toContain('CUSTOM_APP_ERROR_VOLUME_SOURCE_REQUIRED');
        });

        // An empty string is "present" as far as the source check is concerned, so without the
        // length rule it reaches the builder and throws an error naming the opposite problem.
        it('should reject an empty host path rather than reporting it as no source at build time', () => {
          const result = serviceSchema.safeParse(withVolume({ hostPath: '', containerPath: '/var/lib/postgresql' }));
          expect(result.success).toBe(false);
          expect(result.error?.issues.map((issue) => issue.message)).toContain('CUSTOM_APP_ERROR_HOST_PATH_REQUIRED');
        });

        it('should reject an empty container path, which would render as a bare `source:` mount', () => {
          const result = serviceSchema.safeParse(withVolume({ hostPath: '${APP_DATA_DIR}/data', containerPath: '' }));
          expect(result.success).toBe(false);
          expect(result.error?.issues.map((issue) => issue.message)).toContain('CUSTOM_APP_ERROR_CONTAINER_PATH_REQUIRED');
        });

        it('should reject a volume name docker itself would not accept', () => {
          const result = safeParse(serviceSchema, withVolume({ volumeName: '/pg data', containerPath: '/var/lib/postgresql' }));
          expect(result.success).toBe(false);
        });

        it('should accept requiresPosixPermissions on a bind mount', () => {
          const result = safeParse(
            serviceSchema,
            withVolume({ hostPath: '${APP_DATA_DIR}/data/db', containerPath: '/var/lib/postgresql', requiresPosixPermissions: true }),
          );
          expect(result.success).toBe(true);
        });

        it('should reject requiresPosixPermissions on a named volume, which always has them', () => {
          const result = safeParse(
            serviceSchema,
            withVolume({ volumeName: 'pgdata', containerPath: '/var/lib/postgresql', requiresPosixPermissions: true }),
          );
          expect(result.success).toBe(false);
        });

        it('should not treat a named volume as a denied host path', () => {
          const result = safeParse(serviceSchema, withVolume({ volumeName: 'etc', containerPath: '/etc/postgresql' }));
          expect(result.success).toBe(true);
        });

        /*
         * ⚠ THE REJECT-LIST IS A STRING COMPARISON, and nothing canonicalized
         * before it ran. `normalizeCustomAppHostPath` collapsed separators and
         * dropped a trailing slash and stopped there — it never resolved a `.`
         * or `..` segment. So `/etc` was denied while every spelling below,
         * each one character away and each mounting exactly the same directory,
         * went straight through.
         */
        it.each([
          ['/etc/../etc', 'climbs out and back'],
          ['/./etc', 'has a leading dot segment'],
          ['/var/../etc', 'reaches a denied path from an allowed one'],
          ['/var/run/../run/docker.sock', 'reaches the docker socket the long way'],
          ['/app-data/x/../../..', 'walks out to the root'],
          ['${SOME_OTHER_VAR}/etc', 'expands to something we cannot check'],
          ['${APP_DATA_DIR}/../../etc', 'escapes the app data dir it starts in'],
          ['${APP_DATA_DIR_EXTRA}/etc', 'names a different variable that merely starts the same'],
          ['$APP_DATA_DIR_HOME/var/run/docker.sock', 'names a different unbraced variable that merely starts the same'],
          ['/var/run', 'is the directory the denied docker socket sits in'],
          ['/var', 'contains the directory the denied docker socket sits in'],
          // `/var/run` is a symlink to `/run` on every systemd distro: the same socket, by its real name.
          ['/run/docker.sock', 'is the docker socket under its real name'],
          ['/run', 'is the directory that real name sits in'],
          ['/run/containerd/containerd.sock', "is containerd's socket, which runs every container"],
          // ...and the rest of that directory by its symlinked name, which denying `/run` alone left open.
          ['/var/run/containerd/containerd.sock', "is containerd's socket under the symlinked name"],
          ['/var/run/dbus/system_bus_socket', "is dbus's system socket under the symlinked name"],
          ['/var/run/user/1000/docker.sock', 'is a rootless docker socket under the symlinked name'],
          ['/var/lib/docker', "is docker's data-root, holding every container's volumes"],
          ['/var/lib', "contains docker's data-root"],
          ['/var/lib/containerd', "is where docker's containerd image store keeps every container's filesystem"],
          // Compose expands a leading `~` to the `$HOME` of whatever runs it, so the path mounted is not the path checked.
          ['~/.ssh', 'is .ssh in the home directory of whatever runs compose, which can be root'],
          ['~', 'is that home directory itself'],
        ])('should reject %j because it %s', (hostPath) => {
          const result = safeParse(serviceSchema, withVolume({ hostPath, containerPath: '/mnt' }));
          expect(result.success).toBe(false);
        });

        it('should accept a ~ anywhere but the start, where compose leaves it a literal character', () => {
          for (const hostPath of ['${APP_DATA_DIR}/~cache', '/srv/media~old']) {
            expect(safeParse(serviceSchema, withVolume({ hostPath, containerPath: '/data' })).success).toBe(true);
          }
        });

        it('should accept the benign timezone binds, as the install sink does', () => {
          // Both layers share one reject-list, so a bind the install sink clears must not fail
          // validation here — `/etc/localtime` is on nearly every manifest.
          for (const hostPath of ['/etc/localtime', '/etc/timezone']) {
            expect(safeParse(serviceSchema, withVolume({ hostPath, containerPath: hostPath })).success).toBe(true);
          }
        });

        it('should still accept a plain path under the app data dir', () => {
          // `${APP_DATA_DIR}` is substituted rather than rejected: it resolves to
          // the app's own directory, which is on no reject-list.
          const result = safeParse(serviceSchema, withVolume({ hostPath: '${APP_DATA_DIR}/data', containerPath: '/data' }));
          expect(result.success).toBe(true);
        });
      });

      describe('Command Configuration', () => {
        it('should accept string command', () => {
          const service = {
            image: 'nginx:latest',
            name: 'web-server',
            internalPort: 80,
            command: 'nginx -g "daemon off;"',
          };

          const result = safeParse(serviceSchema, service);
          expect(result.success).toBe(true);
        });

        it('should accept array command', () => {
          const service = {
            image: 'nginx:latest',
            name: 'web-server',
            internalPort: 80,
            command: ['nginx', '-g', 'daemon off;'],
          };

          const result = safeParse(serviceSchema, service);
          expect(result.success).toBe(true);
        });
      });

      describe('Security Constraints', () => {
        it('should reject privileged services', () => {
          const service = {
            image: 'nginx:latest',
            name: 'web-server',
            privileged: true,
          };

          const result = safeParse(serviceSchema, service);
          expect(result.success).toBe(false);
        });

        it('should reject docker.sock host mounts', () => {
          const service = {
            image: 'nginx:latest',
            name: 'web-server',
            volumes: [{ hostPath: '/var/run/docker.sock', containerPath: '/var/run/docker.sock' }],
          };

          const result = safeParse(serviceSchema, service);
          expect(result.success).toBe(false);
        });

        it('should reject root filesystem mounts', () => {
          const service = {
            image: 'nginx:latest',
            name: 'web-server',
            volumes: [{ hostPath: '/', containerPath: '/host' }],
          };

          const result = safeParse(serviceSchema, service);
          expect(result.success).toBe(false);
        });
      });

      describe('Health Check Configuration', () => {
        it('should validate complete health check', () => {
          const service = {
            image: 'nginx:latest',
            name: 'web-server',
            internalPort: 80,
            healthCheck: {
              test: 'curl -f http://localhost/',
              interval: '30s',
              timeout: '10s',
              retries: 3,
              startPeriod: '60s',
            },
          };

          const result = safeParse(serviceSchema, service);
          expect(result.success).toBe(true);
        });

        it('should require test field in health check', () => {
          const service = {
            image: 'nginx:latest',
            name: 'web-server',
            internalPort: 80,
            healthCheck: {
              interval: '30s',
              timeout: '10s',
              retries: 3,
            },
          };

          const result = safeParse(serviceSchema, service);
          expect(result.success).toBe(false);
        });
      });

      describe('DependsOn Configuration', () => {
        it('should validate depends_on as array', () => {
          const service = {
            image: 'nginx:latest',
            name: 'web-server',
            internalPort: 80,
            dependsOn: ['database', 'redis'],
          };

          const result = safeParse(serviceSchema, service);
          expect(result.success).toBe(true);
        });

        it('should validate depends_on as object with conditions', () => {
          const service = {
            image: 'nginx:latest',
            name: 'web-server',
            internalPort: 80,
            dependsOn: {
              database: { condition: 'service_healthy' },
              redis: { condition: 'service_started' },
            },
          };

          const result = safeParse(serviceSchema, service);
          expect(result.success).toBe(true);
        });

        it('should reject invalid condition values', () => {
          const service = {
            image: 'nginx:latest',
            name: 'web-server',
            internalPort: 80,
            dependsOn: {
              database: { condition: 'invalid_condition' },
            },
          };

          const result = safeParse(serviceSchema, service);
          expect(result.success).toBe(false);
        });
      });
    });

    describe('DynamicCompose Schema V2', () => {
      describe('Basic Structure', () => {
        it('should validate minimal dynamic compose', () => {
          const compose = {
            schemaVersion: 2 as const,
            services: [
              {
                image: 'nginx:latest',
                name: 'web',
                internalPort: 80,
              },
            ],
          };

          const result = safeParse(dynamicComposeSchema, compose);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.data).toMatchInlineSnapshot(`
              {
                "schemaVersion": 2,
                "services": [
                  {
                    "image": "nginx:latest",
                    "internalPort": 80,
                    "name": "web",
                  },
                ],
              }
            `);
          }
        });

        it('should validate complex dynamic compose with all features', () => {
          const compose = {
            schemaVersion: 2 as const,
            services: [
              {
                // Required fields
                image: 'nginx:alpine',
                name: 'web-server',
                internalPort: 80,

                // Service configuration
                isMain: true,
                networkMode: 'bridge',
                addToMainNetwork: true,
                hostname: 'web-server.local',

                // Resource limits and deployment
                deploy: {
                  resources: {
                    limits: {
                      cpus: '0.5',
                      memory: '512M',
                      pids: 100,
                    },
                    reservations: {
                      cpus: '0.25',
                      memory: '256M',
                      devices: [
                        {
                          capabilities: ['gpu'],
                          driver: 'nvidia',
                          count: 1,
                          deviceIds: ['GPU-12345'],
                        },
                      ],
                    },
                  },
                },

                // Ports configuration
                addPorts: [
                  {
                    containerPort: 9091,
                    hostPort: 9091,
                    tcp: true,
                    interface: '0.0.0.0',
                  },
                  {
                    containerPort: 9090,
                    hostPort: 9090,
                    udp: true,
                  },
                ],

                // Command and entrypoint
                command: ['nginx', '-g', 'daemon off;'],
                entrypoint: ['/docker-entrypoint.sh'],

                // Volumes
                volumes: [
                  {
                    hostPath: '/host/config',
                    containerPath: '/etc/nginx/conf.d',
                    readOnly: true,
                    shared: false,
                    private: true,
                  },
                  {
                    hostPath: '/host/data',
                    containerPath: '/var/www/html',
                    readOnly: false,
                  },
                ],

                // Environment variables
                environment: [
                  { key: 'NODE_ENV', value: 'production' },
                  { key: 'PORT', value: 9091 },
                  { key: 'DEBUG', value: true },
                  { key: 'MAX_CONNECTIONS', value: 1000 },
                ],

                // Network and security
                extraHosts: ['host.docker.internal:host-gateway', 'api.local:192.168.1.100'],
                dns: ['8.8.8.8', '1.1.1.1'],

                // System configuration
                sysctls: {
                  'net.core.somaxconn': 1024,
                  'net.ipv4.tcp_syncookies': 1,
                },

                // Resource limits
                ulimits: {
                  nproc: { soft: 65536, hard: 65536 },
                  nofile: 20000,
                  core: 0,
                  memlock: { soft: -1, hard: -1 },
                },

                // Health check
                healthCheck: {
                  test: 'curl -f http://localhost:80/health || exit 1',
                  interval: '30s',
                  timeout: '10s',
                  retries: 3,
                  startInterval: '5s',
                  startPeriod: '60s',
                },

                // Dependencies
                dependsOn: {
                  database: { condition: 'service_healthy' },
                  redis: { condition: 'service_started' },
                },

                // Security and capabilities
                capAdd: ['NET_ADMIN', 'SYS_TIME'],
                capDrop: ['MKNOD', 'SYS_CHROOT'],
                privileged: false,
                securityOpt: ['no-new-privileges:true', 'apparmor:unconfined'],

                // Process configuration
                pid: 'host',
                user: '1000:1000',
                workingDir: '/app',
                tty: true,
                stdinOpen: true,
                readOnly: false,

                // Memory and storage
                shmSize: '64m',
                devices: ['/dev/snd:/dev/snd:rwm'],

                // Logging
                logging: {
                  driver: 'json-file',
                  options: {
                    'max-size': '10m',
                    'max-file': '3',
                  },
                },

                // Process management
                stopSignal: 'SIGTERM',
                stopGracePeriod: '10s',

                // Labels
                extraLabels: {
                  'app.version': '1.0.0',
                  maintainer: 'team@example.com',
                  production: true,
                },
              },
              {
                // Secondary service with minimal configuration
                image: 'postgres:14',
                name: 'database',
                internalPort: 6543,
                environment: [
                  { key: 'POSTGRES_DB', value: 'myapp' },
                  { key: 'POSTGRES_USER', value: 'dbuser' },
                  { key: 'POSTGRES_PASSWORD', value: 'secret123' },
                ],
                volumes: [
                  {
                    hostPath: '/host/postgres-data',
                    containerPath: '/var/lib/postgresql/data',
                  },
                ],
                healthCheck: {
                  test: 'pg_isready -U dbuser -d myapp',
                  interval: '10s',
                  timeout: '5s',
                  retries: 5,
                },
              },
              {
                // Third service with array-style depends_on
                image: 'redis:alpine',
                name: 'redis',
                dependsOn: ['database'],
                command: 'redis-server --appendonly yes',
                volumes: [
                  {
                    hostPath: '/host/redis-data',
                    containerPath: '/data',
                  },
                ],
              },
            ],

            // Architecture overrides
            overrides: [
              {
                architecture: 'arm64',
                services: [
                  {
                    image: 'nginx:alpine-arm64v8',
                    name: 'web-server',
                  },
                ],
              },
              {
                architecture: 'amd64',
                services: [
                  {
                    image: 'nginx:alpine-amd64',
                    name: 'web-server',
                    deploy: {
                      resources: {
                        limits: {
                          cpus: '1.0',
                          memory: '1G',
                        },
                      },
                    },
                  },
                ],
              },
            ],
          };

          const result = safeParse(dynamicComposeSchema, compose);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.data).toMatchInlineSnapshot(`
              {
                "overrides": [
                  {
                    "architecture": "arm64",
                    "services": [
                      {
                        "image": "nginx:alpine-arm64v8",
                        "name": "web-server",
                      },
                    ],
                  },
                  {
                    "architecture": "amd64",
                    "services": [
                      {
                        "deploy": {
                          "resources": {
                            "limits": {
                              "cpus": "1.0",
                              "memory": "1G",
                            },
                          },
                        },
                        "image": "nginx:alpine-amd64",
                        "name": "web-server",
                      },
                    ],
                  },
                ],
                "schemaVersion": 2,
                "services": [
                  {
                    "addPorts": [
                      {
                        "containerPort": 9091,
                        "hostPort": 9091,
                        "interface": "0.0.0.0",
                        "tcp": true,
                      },
                      {
                        "containerPort": 9090,
                        "hostPort": 9090,
                        "udp": true,
                      },
                    ],
                    "addToMainNetwork": true,
                    "capAdd": [
                      "NET_ADMIN",
                      "SYS_TIME",
                    ],
                    "capDrop": [
                      "MKNOD",
                      "SYS_CHROOT",
                    ],
                    "command": [
                      "nginx",
                      "-g",
                      "daemon off;",
                    ],
                    "dependsOn": {
                      "database": {
                        "condition": "service_healthy",
                      },
                      "redis": {
                        "condition": "service_started",
                      },
                    },
                    "deploy": {
                      "resources": {
                        "limits": {
                          "cpus": "0.5",
                          "memory": "512M",
                          "pids": 100,
                        },
                        "reservations": {
                          "cpus": "0.25",
                          "devices": [
                            {
                              "capabilities": [
                                "gpu",
                              ],
                              "count": 1,
                              "deviceIds": [
                                "GPU-12345",
                              ],
                              "driver": "nvidia",
                            },
                          ],
                          "memory": "256M",
                        },
                      },
                    },
                    "devices": [
                      "/dev/snd:/dev/snd:rwm",
                    ],
                    "dns": [
                      "8.8.8.8",
                      "1.1.1.1",
                    ],
                    "entrypoint": [
                      "/docker-entrypoint.sh",
                    ],
                    "environment": [
                      {
                        "key": "NODE_ENV",
                        "value": "production",
                      },
                      {
                        "key": "PORT",
                        "value": 9091,
                      },
                      {
                        "key": "DEBUG",
                        "value": true,
                      },
                      {
                        "key": "MAX_CONNECTIONS",
                        "value": 1000,
                      },
                    ],
                    "extraHosts": [
                      "host.docker.internal:host-gateway",
                      "api.local:192.168.1.100",
                    ],
                    "extraLabels": {
                      "app.version": "1.0.0",
                      "maintainer": "team@example.com",
                      "production": true,
                    },
                    "healthCheck": {
                      "interval": "30s",
                      "retries": 3,
                      "startInterval": "5s",
                      "startPeriod": "60s",
                      "test": "curl -f http://localhost:80/health || exit 1",
                      "timeout": "10s",
                    },
                    "hostname": "web-server.local",
                    "image": "nginx:alpine",
                    "internalPort": 80,
                    "isMain": true,
                    "logging": {
                      "driver": "json-file",
                      "options": {
                        "max-file": "3",
                        "max-size": "10m",
                      },
                    },
                    "name": "web-server",
                    "networkMode": "bridge",
                    "pid": "host",
                    "privileged": false,
                    "readOnly": false,
                    "securityOpt": [
                      "no-new-privileges:true",
                      "apparmor:unconfined",
                    ],
                    "shmSize": "64m",
                    "stdinOpen": true,
                    "stopGracePeriod": "10s",
                    "stopSignal": "SIGTERM",
                    "sysctls": {
                      "net.core.somaxconn": 1024,
                      "net.ipv4.tcp_syncookies": 1,
                    },
                    "tty": true,
                    "ulimits": {
                      "core": 0,
                      "memlock": {
                        "hard": -1,
                        "soft": -1,
                      },
                      "nofile": 20000,
                      "nproc": {
                        "hard": 65536,
                        "soft": 65536,
                      },
                    },
                    "user": "1000:1000",
                    "volumes": [
                      {
                        "containerPath": "/etc/nginx/conf.d",
                        "hostPath": "/host/config",
                        "private": true,
                        "readOnly": true,
                        "shared": false,
                      },
                      {
                        "containerPath": "/var/www/html",
                        "hostPath": "/host/data",
                        "readOnly": false,
                      },
                    ],
                    "workingDir": "/app",
                  },
                  {
                    "environment": [
                      {
                        "key": "POSTGRES_DB",
                        "value": "myapp",
                      },
                      {
                        "key": "POSTGRES_USER",
                        "value": "dbuser",
                      },
                      {
                        "key": "POSTGRES_PASSWORD",
                        "value": "secret123",
                      },
                    ],
                    "healthCheck": {
                      "interval": "10s",
                      "retries": 5,
                      "test": "pg_isready -U dbuser -d myapp",
                      "timeout": "5s",
                    },
                    "image": "postgres:14",
                    "internalPort": 6543,
                    "name": "database",
                    "volumes": [
                      {
                        "containerPath": "/var/lib/postgresql/data",
                        "hostPath": "/host/postgres-data",
                      },
                    ],
                  },
                  {
                    "command": "redis-server --appendonly yes",
                    "dependsOn": [
                      "database",
                    ],
                    "image": "redis:alpine",
                    "name": "redis",
                    "volumes": [
                      {
                        "containerPath": "/data",
                        "hostPath": "/host/redis-data",
                      },
                    ],
                  },
                ],
              }
            `);
          }
        });

        it('should require schemaVersion 2', () => {
          const compose = {
            schemaVersion: 1,
            services: [
              {
                image: 'nginx:latest',
                name: 'web',
                internalPort: 80,
              },
            ],
          };

          const result = safeParse(dynamicComposeSchema, compose);
          expect(result.success).toBe(false);
        });

        it('should require at least one service', () => {
          const compose = {
            schemaVersion: 2 as const,
            services: [],
          };

          const result = safeParse(dynamicComposeSchema, compose);
          expect(result.success).toBe(false);
        });

        it('should validate multiple services', () => {
          const compose = {
            schemaVersion: 2 as const,
            services: [
              {
                image: 'nginx:latest',
                name: 'web',
                internalPort: 80,
              },
              {
                image: 'postgres:14',
                name: 'database',
                internalPort: 6543,
              },
            ],
          };

          const result = safeParse(dynamicComposeSchema, compose);
          expect(result.success).toBe(true);
        });
      });

      describe('Overrides Configuration', () => {
        it('should validate overrides with architecture', () => {
          const compose = {
            schemaVersion: 2 as const,
            services: [
              {
                image: 'nginx:latest',
                name: 'web',
                internalPort: 80,
              },
            ],
            overrides: [
              {
                architecture: 'arm64',
                services: [
                  {
                    image: 'nginx:latest-arm64',
                    name: 'web',
                    internalPort: 80,
                  },
                ],
              },
            ],
          };

          const result = safeParse(dynamicComposeSchema, compose);
          expect(result.success).toBe(true);
        });

        it('should validate overrides without architecture', () => {
          const compose = {
            schemaVersion: 2 as const,
            services: [
              {
                image: 'nginx:latest',
                name: 'web',
                internalPort: 80,
              },
            ],
            overrides: [
              {
                services: [
                  {
                    image: 'nginx:alpine',
                    name: 'web',
                    internalPort: 80,
                  },
                ],
              },
            ],
          };

          const result = safeParse(dynamicComposeSchema, compose);
          expect(result.success).toBe(true);
        });

        it('should reject invalid override structure', () => {
          const compose = {
            schemaVersion: 2 as const,
            services: [
              {
                image: 'nginx:latest',
                name: 'web',
                internalPort: 80,
              },
            ],
            overrides: [
              {
                architecture: 'x86', // invalid architecture value
                services: [{}], // incomplete service
              },
            ],
          };

          const result = safeParse(dynamicComposeSchema, compose);
          expect(result.success).toBe(false);
        });
      });
    });

    describe('Edge Cases and Error Conditions', () => {
      it('should handle null and undefined values appropriately', () => {
        const testCases = [
          null,
          undefined,
          { schemaVersion: 2, services: null },
          { schemaVersion: 2, services: undefined },
          { schemaVersion: null, services: [] },
        ];

        for (const testCase of testCases) {
          const result = safeParse(dynamicComposeSchema, testCase);
          expect(result.success).toBe(false);
        }
      });

      it('should handle malformed data structures', () => {
        const testCases = [
          'string',
          123,
          [],
          { schemaVersion: '2', services: 'not-array' },
          { schemaVersion: 2, services: [{ invalid: 'service' }] },
        ];

        for (const testCase of testCases) {
          const result = safeParse(dynamicComposeSchema, testCase);
          expect(result.success).toBe(false);
        }
      });
    });

    describe('Schema Transformation and Version Migration', () => {
      it('should handle V1 to V2 transformation edge cases', () => {
        const edgeCases = [
          // Missing required fields after transformation
          { services: [{ image: 'nginx' }] },
          // Invalid port after transformation
          { services: [{ image: 'nginx', name: 'web', internalPort: 0 }] },
          // Invalid environment after transformation
          { services: [{ image: 'nginx', name: 'web', internalPort: 80, environment: 'invalid' }] },
        ];

        for (const testCase of edgeCases) {
          const result = safeParse(dynamicComposeSchema, testCase);
          expect(result.success).toBe(false);
        }
      });
    });
  });
});

describe('collectServiceSecurityViolations (install-sink app sandbox)', () => {
  it('flags privileged services without a grant', () => {
    const violations = collectServiceSecurityViolations({ privileged: true });
    expect(violations.map((v) => v.message)).toContain('CUSTOM_APP_ERROR_PRIVILEGED_NOT_ALLOWED');
  });

  it('allows privileged services when granted', () => {
    expect(collectServiceSecurityViolations({ privileged: true }, { privileged: true })).toHaveLength(0);
  });

  /*
   * ⚠ REFUSING `privileged: true` WHILE ACCEPTING THESE WAS A SANDBOX THAT COULD
   * BE STEPPED OVER RATHER THAN CLIMBED. Neither layer checked `capAdd`,
   * `devices` or `securityOpt`, and each of them grants the same power the
   * `privileged` refusal exists to withhold.
   */
  it('flags capabilities that are equivalent to privileged', () => {
    for (const cap of ['SYS_ADMIN', 'SYS_MODULE', 'SYS_RAWIO', 'SYS_PTRACE', 'DAC_READ_SEARCH', 'NET_ADMIN']) {
      expect(collectServiceSecurityViolations({ capAdd: [cap] }).map((v) => v.message)).toContain('CUSTOM_APP_ERROR_CAP_ADD_NOT_ALLOWED');
    }

    // Docker accepts either spelling, so both have to be normalised.
    expect(collectServiceSecurityViolations({ capAdd: ['cap_sys_admin'] })).toHaveLength(1);
  });

  it('allows the safe capability set without a grant, and a granted one with', () => {
    // The safe set is Docker's own default set, which the container already holds: re-adding one of
    // these grants nothing, so refusing it would only fail installs.
    expect(collectServiceSecurityViolations({ capAdd: ['NET_BIND_SERVICE', 'CHOWN', 'MKNOD', 'NET_RAW', 'SYS_CHROOT'] })).toHaveLength(0);
    expect(collectServiceSecurityViolations({ capAdd: ['SYS_ADMIN'] }, { capAdd: ['SYS_ADMIN'] })).toHaveLength(0);
  });

  it('flags securityOpt entries that switch confinement off', () => {
    for (const opt of ['apparmor=unconfined', 'seccomp=unconfined', 'systempaths=unconfined', 'label:disable']) {
      expect(collectServiceSecurityViolations({ securityOpt: [opt] }).map((v) => v.message)).toContain('CUSTOM_APP_ERROR_SECURITY_OPT_NOT_ALLOWED');
    }
  });

  it('leaves securityOpt entries that tighten confinement alone', () => {
    // Matched on the VALUE half, so a real profile and `no-new-privileges` pass.
    expect(collectServiceSecurityViolations({ securityOpt: ['no-new-privileges:true', 'apparmor=my-profile'] })).toHaveLength(0);
    expect(collectServiceSecurityViolations({ securityOpt: ['seccomp=unconfined'] }, { securityOpt: ['seccomp=unconfined'] })).toHaveLength(0);
  });

  it('flags a device that IS the host, not merely a device', () => {
    // `devices` is `host:container[:perms]`, and only the host half escapes.
    for (const device of ['/dev:/dev', '/dev/sda:/dev/sda', '/dev/nvme0n1:/dev/nvme0n1', '/dev/mem:/dev/mem']) {
      expect(collectServiceSecurityViolations({ devices: [device] }).map((v) => v.message)).toContain('CUSTOM_APP_ERROR_DEVICE_NOT_ALLOWED');
    }

    expect(collectServiceSecurityViolations({ devices: ['/dev/../dev/sda:/dev/sda'] })).toHaveLength(1);
  });

  it('leaves the ordinary device passthroughs alone', () => {
    /*
     * ⚠ NARROWER THAN THE HOST-PATH REJECT-LIST ON PURPOSE. `/dev` is on that
     * list, but passing a single character device through is what a Zigbee
     * dongle, a GPU or a capture card needs — refusing them all would break real
     * installs and buy nothing, because the escape is a device that IS the host.
     */
    expect(
      collectServiceSecurityViolations({
        devices: ['/dev/ttyUSB0:/dev/ttyUSB0', '/dev/dri:/dev/dri', '/dev/kfd:/dev/kfd', '/dev/video0:/dev/video0'],
      }),
    ).toHaveLength(0);
  });

  it('does not let devices become a second way to mount a denied directory', () => {
    expect(collectServiceSecurityViolations({ devices: ['/etc:/host-etc'] }).map((v) => v.message)).toContain('CUSTOM_APP_ERROR_DEVICE_NOT_ALLOWED');
    expect(collectServiceSecurityViolations({ devices: ['/dev/sda:/dev/sda'] }, { devices: ['/dev/sda'] })).toHaveLength(0);
  });

  it('does not let a privileged grant widen the host-path reject-list', () => {
    // Grants are per-field and per-path: `home-assistant` is granted `privileged`, not `/` or the
    // docker socket. Skipping the bind checks for a privileged app would hand it both.
    const grants = { privileged: true };
    expect(collectServiceSecurityViolations({ privileged: true, volumes: [{ hostPath: '/' }] }, grants).map((v) => v.message)).toContain(
      'CUSTOM_APP_ERROR_HOST_PATH_DENIED',
    );
    expect(
      collectServiceSecurityViolations({ privileged: true, volumes: [{ volumeName: '/var/run/docker.sock' }] }, grants).map((v) => v.message),
    ).toContain('CUSTOM_APP_ERROR_VOLUME_NAME_INVALID');
  });

  it("does not let a privileged grant cover the app's other, unprivileged services", () => {
    // `duix-avatar` and `refly` run one privileged sidecar beside ordinary services. The
    // subsumption argument holds only for the service that actually runs privileged.
    const grants = { privileged: true };
    expect(collectServiceSecurityViolations({ capAdd: ['SYS_ADMIN'] }, grants).map((v) => v.message)).toContain(
      'CUSTOM_APP_ERROR_CAP_ADD_NOT_ALLOWED',
    );
    expect(collectServiceSecurityViolations({ devices: ['/dev/sda:/dev/sda'] }, grants).map((v) => v.message)).toContain(
      'CUSTOM_APP_ERROR_DEVICE_NOT_ALLOWED',
    );
    // The service that IS privileged needs no separate check: privileged already confers all three.
    expect(collectServiceSecurityViolations({ privileged: true, capAdd: ['SYS_ADMIN'] }, grants)).toHaveLength(0);
  });

  it('matches a grant against the other spelling docker accepts', () => {
    expect(collectServiceSecurityViolations({ capAdd: ['SYS_ADMIN'] }, { capAdd: ['CAP_SYS_ADMIN'] })).toHaveLength(0);
    expect(collectServiceSecurityViolations({ capAdd: ['CAP_SYS_ADMIN'] }, { capAdd: ['SYS_ADMIN'] })).toHaveLength(0);
    expect(collectServiceSecurityViolations({ securityOpt: ['seccomp:unconfined'] }, { securityOpt: ['seccomp=unconfined'] })).toHaveLength(0);
  });

  it('flags the SELinux and seccomp-profile forms that disable confinement without saying "unconfined"', () => {
    // `label=type:spc_t` is the super-privileged-container type, and a seccomp profile is a path to
    // a file the Hub cannot audit — one the app can write into its own data directory.
    for (const opt of ['label=type:spc_t', 'label=user:system_u', 'seccomp=/app-data/store/app/data/permissive.json']) {
      expect(collectServiceSecurityViolations({ securityOpt: [opt] }).map((v) => v.message)).toContain('CUSTOM_APP_ERROR_SECURITY_OPT_NOT_ALLOWED');
    }
  });

  it('flags the block devices that reach the host disk under another name', () => {
    // A device that is the host disk is one whatever it is spelled: the eMMC/SD card an
    // appliance boots from, and the by-id/by-uuid symlinks udev keeps for every disk.
    for (const device of [
      '/dev/mmcblk0:/dev/mmcblk0',
      '/dev/disk/by-id/ata-SOME_DISK:/dev/disk',
      '/dev/block/8:0',
      '/dev/root:/dev/root',
      '/dev/nbd0:/dev/nbd0',
      '/dev/ram0:/dev/ram0',
    ]) {
      expect(collectServiceSecurityViolations({ devices: [device] }).map((v) => v.message)).toContain('CUSTOM_APP_ERROR_DEVICE_NOT_ALLOWED');
    }

    // `/dev/random` and `/dev/urandom` start with the same letters as `/dev/ram*` and must survive.
    expect(collectServiceSecurityViolations({ devices: ['/dev/random:/dev/random', '/dev/urandom:/dev/urandom'] })).toHaveLength(0);
  });

  it('flags a container namespace, which reaches whatever that container binds on loopback', () => {
    expect(collectServiceSecurityViolations({ networkMode: 'container:ci-os-hub' }).map((v) => v.message)).toContain(
      'CUSTOM_APP_ERROR_NETWORK_MODE_HOST_NOT_ALLOWED',
    );
    expect(collectServiceSecurityViolations({ pid: 'container:ci-os-hub' }).map((v) => v.message)).toContain('CUSTOM_APP_ERROR_PID_HOST_NOT_ALLOWED');
    // A service reference stays inside the app's own compose project.
    expect(collectServiceSecurityViolations({ networkMode: 'service:db' })).toHaveLength(0);
  });

  // The Engine reads an unknown network mode as a network NAME and attaches the container to it, so
  // `networkMode: ci-hub_edge` put an app beside the two proxies Traefik and the Hub trust to vouch
  // for a client's address, and `ci-hub_internal` beside Postgres and RabbitMQ. No grant lifts it.
  it('flags a network mode that names a network, whatever the grants', () => {
    for (const networkMode of [
      'ci-hub_edge',
      'ci-hub_internal',
      'ci-hub_network',
      'ci-os-hub_network',
      'other-app_1_network',
      'bridge ',
      'service:',
    ]) {
      const violations = collectServiceSecurityViolations({ networkMode }, { networkModeHost: true });
      expect(violations, networkMode).toEqual([
        { path: ['networkMode'], message: 'CUSTOM_APP_ERROR_NETWORK_MODE_NOT_ALLOWED', hostPath: networkMode },
      ]);
    }

    for (const networkMode of ['bridge', 'none', 'default', 'service:bisq2-node', '']) {
      expect(collectServiceSecurityViolations({ networkMode }), networkMode).toHaveLength(0);
    }
    // `host` and `container:` are known modes, refused only for the want of their grant.
    expect(collectServiceSecurityViolations({ networkMode: 'container:ci-hub' }).map((v) => v.message)).toEqual([
      'CUSTOM_APP_ERROR_NETWORK_MODE_HOST_NOT_ALLOWED',
    ]);
  });

  it('flags host network and host pid namespaces', () => {
    expect(collectServiceSecurityViolations({ networkMode: 'host' }).map((v) => v.message)).toContain(
      'CUSTOM_APP_ERROR_NETWORK_MODE_HOST_NOT_ALLOWED',
    );
    expect(collectServiceSecurityViolations({ pid: 'host' }).map((v) => v.message)).toContain('CUSTOM_APP_ERROR_PID_HOST_NOT_ALLOWED');
    expect(collectServiceSecurityViolations({ networkMode: 'host' }, { networkModeHost: true })).toHaveLength(0);
    expect(collectServiceSecurityViolations({ pid: 'host' }, { pidHost: true })).toHaveLength(0);
  });

  it('flags denied host-path binds and honors per-path grants', () => {
    const svc = { volumes: [{ hostPath: '/var/run/docker.sock' }] };
    expect(collectServiceSecurityViolations(svc).map((v) => v.message)).toContain('CUSTOM_APP_ERROR_HOST_PATH_DENIED');
    expect(collectServiceSecurityViolations(svc, { hostPaths: ['/var/run/docker.sock'] })).toHaveLength(0);
    // a granted path does not whitelist a different denied path
    expect(collectServiceSecurityViolations({ volumes: [{ hostPath: '/root/.ssh' }] }, { hostPaths: ['/var/run/docker.sock'] })).toHaveLength(1);
  });

  it('flags the directory a denied path sits in, not only the denied path itself', () => {
    // `/var/lib/docker` is on the reject-list, so binding `/var/lib` or `/var` hands over the same
    // data under a spelling the equality and prefix tests never see.
    for (const hostPath of ['/var/lib', '/var']) {
      expect(collectServiceSecurityViolations({ volumes: [{ hostPath }] }).map((v) => v.message)).toContain('CUSTOM_APP_ERROR_HOST_PATH_DENIED');
    }

    // A sibling that contains nothing denied stays allowed: this is an ancestor rule, not a new root.
    expect(collectServiceSecurityViolations({ volumes: [{ hostPath: '/var/lib/myapp' }] })).toHaveLength(0);
  });

  it('denies /run under both of its names, and a grant for one name does not cover the other', () => {
    // `/var/run` is a symlink to `/run`. The kernel follows it at mount time and the reject-list
    // compares strings, so denying one spelling left every socket in the directory open under the other.
    for (const hostPath of [
      '/run/docker.sock',
      '/run/containerd/containerd.sock',
      '/var/run/containerd/containerd.sock',
      '/var/run/dbus/system_bus_socket',
    ]) {
      expect(collectServiceSecurityViolations({ volumes: [{ hostPath }] }).map((v) => v.message)).toContain('CUSTOM_APP_ERROR_HOST_PATH_DENIED');
    }

    // Grants match the spelling they name. The docker-socket apps are granted `/var/run/docker.sock`,
    // and that must not stretch to the same socket asked for by its other name.
    const grants = { hostPaths: ['/var/run/docker.sock'] };
    expect(collectServiceSecurityViolations({ volumes: [{ hostPath: '/var/run/docker.sock' }] }, grants)).toHaveLength(0);
    expect(collectServiceSecurityViolations({ volumes: [{ hostPath: '/run/docker.sock' }] }, grants)).toHaveLength(1);

    // A root matches whole path segments, so a sibling that merely starts with the same letters stays allowed.
    expect(collectServiceSecurityViolations({ volumes: [{ hostPath: '/runner' }, { hostPath: '/var/lib/docker-backup' }] })).toHaveLength(0);
  });

  it('refuses a leading ~, which compose expands to the home directory of whatever runs it', () => {
    // `~/.ssh` is `/root/.ssh` under a root `HOME`: a denied root, under a spelling no denied root begins with.
    for (const hostPath of ['~/.ssh', '~']) {
      expect(collectServiceSecurityViolations({ volumes: [{ hostPath }] }).map((v) => v.message)).toContain('CUSTOM_APP_ERROR_HOST_PATH_DENIED');
    }

    // Compose expands `~` only at the start of a path; one anywhere else is a literal character.
    expect(collectServiceSecurityViolations({ volumes: [{ hostPath: '/srv/media~old' }] })).toHaveLength(0);
  });

  it('never flags the benign /etc/localtime and /etc/timezone binds', () => {
    expect(collectServiceSecurityViolations({ volumes: [{ hostPath: '/etc/localtime' }, { hostPath: '/etc/timezone' }] })).toHaveLength(0);
  });

  it('does not flag a genuine named volume, which exposes no host path', () => {
    expect(collectServiceSecurityViolations({ volumes: [{ volumeName: 'pgdata' }] })).toHaveLength(0);
  });

  // Compose reads `/var/run/docker.sock` in the source slot as a BIND, whatever field it arrived in,
  // so volumeName must not become an unchecked route to a host path.
  it('flags a volumeName that is really a host path', () => {
    for (const volumeName of ['/var/run/docker.sock', './host-dir', '../escape', '/', '~/secrets']) {
      expect(collectServiceSecurityViolations({ volumes: [{ volumeName }] }).map((v) => v.message)).toContain('CUSTOM_APP_ERROR_VOLUME_NAME_INVALID');
    }
  });

  it('flags a path-shaped volumeName even for an app granted that exact host path', () => {
    // The grant covers binds the app declares honestly via hostPath; it must not turn the
    // volumeName field into a second, unvalidated way to ask for the same access.
    const violations = collectServiceSecurityViolations(
      { volumes: [{ volumeName: '/var/run/docker.sock' }] },
      { hostPaths: ['/var/run/docker.sock'] },
    );
    expect(violations.map((v) => v.message)).toContain('CUSTOM_APP_ERROR_VOLUME_NAME_INVALID');
  });

  it('keeps the trusted allowlist tight and self-consistent', () => {
    // Guard against accidental broadening: every allowlisted app must resolve to zero
    // violations for exactly the access it is granted, and nothing else.
    expect(Object.keys(TRUSTED_APP_SECURITY_ALLOWLIST).sort()).toEqual([
      'anything-llm',
      'changedetection',
      'coder',
      'comfyui',
      'coolify',
      'dnsmasq',
      'duix-avatar',
      'falco',
      'filebrowser-quantum',
      'gluetun',
      'home-assistant',
      'hunyuan3d-rocm',
      'librenms',
      'macos',
      'maxun',
      'navidrome',
      'netalertx',
      'netdata',
      'pangolin',
      'pi-hole',
      'proxmox-backup',
      'refly',
      'steam-headless',
      'strix',
      'sup3rs3cretmes5age',
      'torollo',
      'transmission-vpn',
      'wg-easy',
      'windows',
      'windows-arm',
      'wireguard',
      'zerotier-one',
      'zigbee2mqtt',
      'zwave-js-ui',
    ]);
    expect(
      collectServiceSecurityViolations({ privileged: true, networkMode: 'host' }, TRUSTED_APP_SECURITY_ALLOWLIST['home-assistant']),
    ).toHaveLength(0);
    expect(
      collectServiceSecurityViolations(
        { volumes: [{ hostPath: '/proc' }, { hostPath: '/sys' }, { hostPath: '/var/run/docker.sock' }] },
        TRUSTED_APP_SECURITY_ALLOWLIST.netdata,
      ),
    ).toHaveLength(0);
    expect(
      collectServiceSecurityViolations({ volumes: [{ hostPath: '/var/run/docker.sock' }] }, TRUSTED_APP_SECURITY_ALLOWLIST.torollo),
    ).toHaveLength(0);
    expect(collectServiceSecurityViolations({ volumes: [{ hostPath: '/' }] }, TRUSTED_APP_SECURITY_ALLOWLIST['filebrowser-quantum'])).toHaveLength(0);
    // torollo's grant is per-path: privileged and other denied paths stay rejected
    expect(
      collectServiceSecurityViolations({ privileged: true, volumes: [{ hostPath: '/proc' }] }, TRUSTED_APP_SECURITY_ALLOWLIST.torollo),
    ).toHaveLength(2);
  });

  it('grants the capability and confinement holes the shipped apps already rely on', () => {
    expect(collectServiceSecurityViolations({ capAdd: ['NET_ADMIN'] }, TRUSTED_APP_SECURITY_ALLOWLIST.wireguard)).toHaveLength(0);
    expect(collectServiceSecurityViolations({ capAdd: ['NET_ADMIN', 'SYS_MODULE'] }, TRUSTED_APP_SECURITY_ALLOWLIST.pangolin)).toHaveLength(0);
    // The VPN apps CI-Marketplace#1672 publishes: `/dev/net/tun` is an ordinary character device,
    // so NET_ADMIN alone covers what their manifests ask for, as it does for gluetun and wireguard.
    expect(
      collectServiceSecurityViolations({ capAdd: ['NET_ADMIN'], devices: ['/dev/net/tun'] }, TRUSTED_APP_SECURITY_ALLOWLIST['transmission-vpn']),
    ).toHaveLength(0);
    expect(collectServiceSecurityViolations({ capAdd: ['NET_ADMIN'] }, TRUSTED_APP_SECURITY_ALLOWLIST['wg-easy'])).toHaveLength(0);
    expect(
      collectServiceSecurityViolations({ capAdd: ['SYS_ADMIN'], securityOpt: ['seccomp=unconfined'] }, TRUSTED_APP_SECURITY_ALLOWLIST.maxun),
    ).toHaveLength(0);
    expect(
      collectServiceSecurityViolations({ capAdd: ['BPF', 'PERFMON', 'SYS_PTRACE', 'SYS_RESOURCE'] }, TRUSTED_APP_SECURITY_ALLOWLIST.falco),
    ).toHaveLength(0);

    // Still per-field: wireguard's NET_ADMIN grant buys it nothing else.
    expect(collectServiceSecurityViolations({ capAdd: ['SYS_ADMIN'] }, TRUSTED_APP_SECURITY_ALLOWLIST.wireguard)).toHaveLength(1);
    expect(collectServiceSecurityViolations({ privileged: true }, TRUSTED_APP_SECURITY_ALLOWLIST.wireguard)).toHaveLength(1);
    expect(collectServiceSecurityViolations({ volumes: [{ hostPath: '/etc' }] }, TRUSTED_APP_SECURITY_ALLOWLIST.pangolin)).toHaveLength(1);
    // wg-easy's upstream compose lists SYS_MODULE too; the manifest drops it and the grant does not carry it.
    expect(collectServiceSecurityViolations({ capAdd: ['NET_ADMIN', 'SYS_MODULE'] }, TRUSTED_APP_SECURITY_ALLOWLIST['wg-easy'])).toHaveLength(1);
  });

  it('grants the install-form host paths the device owner supplies, and only those', () => {
    /*
     * The Hub builds the compose `.env` from `config.form_fields`, so these expansions resolve to a
     * path the device owner typed. The grant is the literal spelling the manifest uses, because an
     * expansion cannot be canonicalized before compose resolves it.
     */
    expect(
      collectServiceSecurityViolations({ devices: ['${ZIGBEE2MQTT_DEVICE}:/dev/ttyACM0'] }, TRUSTED_APP_SECURITY_ALLOWLIST.zigbee2mqtt),
    ).toHaveLength(0);
    expect(
      collectServiceSecurityViolations({ devices: ['${ZWAVE_DEVICE_PATH}:/dev/zwave'] }, TRUSTED_APP_SECURITY_ALLOWLIST['zwave-js-ui']),
    ).toHaveLength(0);
    expect(
      collectServiceSecurityViolations(
        { volumes: [{ hostPath: '${NAVIDROME_MUSIC_FOLDER:-${APP_DATA_DIR}/music}' }] },
        TRUSTED_APP_SECURITY_ALLOWLIST.navidrome,
      ),
    ).toHaveLength(0);

    // A DIFFERENT expansion is still unresolvable, grant or no grant.
    expect(collectServiceSecurityViolations({ devices: ['${SOME_OTHER_VAR}:/dev/x'] }, TRUSTED_APP_SECURITY_ALLOWLIST.zigbee2mqtt)).toHaveLength(1);
    expect(
      collectServiceSecurityViolations({ volumes: [{ hostPath: '${MEDIA_DIR}/music' }] }, TRUSTED_APP_SECURITY_ALLOWLIST.navidrome),
    ).toHaveLength(1);
    // And the grant does not travel to another app.
    expect(collectServiceSecurityViolations({ devices: ['${ZIGBEE2MQTT_DEVICE}:/dev/x'] }, TRUSTED_APP_SECURITY_ALLOWLIST.wireguard)).toHaveLength(1);
  });
});

describe('dynamicComposeFormSchema', () => {
  // Regression: the custom-app builder form derived its resolver with
  // `dynamicComposeSchema.omit({ schemaVersion: true })`. Zod 4 throws
  // "`.omit()` cannot be used on object schemas containing refinements" at
  // module-evaluation time, which took the whole /apps/create route down.
  it('is derivable without throwing, and omits schemaVersion', () => {
    expect(() => dynamicComposeObject.omit({ schemaVersion: true })).not.toThrow();
    expect(Object.keys(dynamicComposeFormSchema.shape)).not.toContain('schemaVersion');
    expect(Object.keys(dynamicComposeFormSchema.shape)).toContain('services');
  });

  it('rejects .omit() on the refined schema, so callers must use the form schema', () => {
    expect(() => (dynamicComposeSchemaZod as unknown as { omit: (m: object) => unknown }).omit({ schemaVersion: true })).toThrow(/refinements/);
  });

  it('accepts a service list with no schemaVersion supplied', () => {
    const result = dynamicComposeFormSchema.safeParse({
      services: [{ image: 'nginx:latest', name: 'web', internalPort: 80 }],
    });
    expect(result.success).toBe(true);
  });

  it('still enforces the override security refinement', () => {
    const result = dynamicComposeFormSchema.safeParse({
      services: [{ image: 'nginx:latest', name: 'web', internalPort: 80 }],
      overrides: [{ architecture: 'arm64', services: [{ privileged: true }] }],
    });
    expect(result.success).toBe(false);
  });
});
