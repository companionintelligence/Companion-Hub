import type { Architecture } from '@/common/constants';
import type { ServiceInput } from '@ci-hub/common/schemas';
import { describe, expect, it } from 'vitest';
import { mergeArchitectureOverrides } from '../compose-helpers';

describe('mergeArchitectureOverrides', () => {
  const baseServices: ServiceInput[] = [
    {
      name: 'app',
      image: 'app:latest',
      isMain: true,
      internalPort: 80,
    },
    {
      name: 'db',
      image: 'mysql:latest',
      internalPort: 3306,
      environment: [{ key: 'MYSQL_ROOT_PASSWORD', value: 'password' }],
    },
  ];

  it('should return base services if no overrides are provided', () => {
    const result = mergeArchitectureOverrides(baseServices, [], 'amd64');
    expect(result).toEqual(baseServices);
  });

  it('should return base services if no matching architecture override is found', () => {
    const overrides = [
      {
        architecture: 'arm64' as Architecture,
        services: [
          {
            name: 'app',
            image: 'app:arm64-latest',
          },
        ],
      },
    ];

    const result = mergeArchitectureOverrides(baseServices, overrides, 'amd64');
    expect(result).toEqual(baseServices);
  });

  it('should correctly merge arm64 overrides on arm64 architecture', () => {
    const overrides = [
      {
        architecture: 'arm64' as Architecture,
        services: [
          {
            name: 'app',
            image: 'app:arm64-latest',
            environment: [{ key: 'ENV_VAR', value: 'arm64-value' }],
          },
        ],
      },
    ];

    const expected = [
      {
        name: 'app',
        image: 'app:arm64-latest', // Overridden
        isMain: true,
        internalPort: 80,
        environment: [{ key: 'ENV_VAR', value: 'arm64-value' }],
      },
      {
        name: 'db',
        image: 'mysql:latest',
        internalPort: 3306,
        environment: [{ key: 'MYSQL_ROOT_PASSWORD', value: 'password' }],
      },
    ];

    const result = mergeArchitectureOverrides(baseServices, overrides, 'arm64');
    expect(result).toEqual(expected);
  });

  it('should correctly merge amd64 overrides on amd64 architecture', () => {
    const overrides = [
      {
        architecture: 'amd64' as Architecture,
        services: [
          {
            name: 'app',
            image: 'app:amd64-latest',
            environment: [{ key: 'ENV_VAR', value: 'amd64-value' }],
          },
        ],
      },
    ];

    const expected = [
      {
        name: 'app',
        image: 'app:amd64-latest', // Overridden
        isMain: true,
        internalPort: 80,
        environment: [
          { key: 'ENV_VAR', value: 'amd64-value' }, // Added from override
        ],
      },
      {
        name: 'db',
        image: 'mysql:latest',
        internalPort: 3306,
        environment: [{ key: 'MYSQL_ROOT_PASSWORD', value: 'password' }],
      },
    ];

    const result = mergeArchitectureOverrides(baseServices, overrides, 'amd64');
    expect(result).toEqual(expected);
  });

  it('should replace arrays rather than merging them', () => {
    const baseServicesWithArray: ServiceInput[] = [
      {
        name: 'app',
        image: 'app:latest',
        internalPort: 80,
        volumes: [
          {
            hostPath: '/data',
            containerPath: '/app/data',
          },
        ],
      },
    ];

    const overrides = [
      {
        architecture: 'arm64' as Architecture,
        services: [
          {
            name: 'app',
            volumes: [
              {
                hostPath: '/arm64-data',
                containerPath: '/app/arm64-data',
              },
            ],
          },
        ],
      },
    ];

    const expected = [
      {
        name: 'app',
        image: 'app:latest',
        internalPort: 80,
        volumes: [
          {
            hostPath: '/arm64-data',
            containerPath: '/app/arm64-data',
          },
        ],
      },
    ];

    const result = mergeArchitectureOverrides(baseServicesWithArray, overrides, 'arm64');
    expect(result).toEqual(expected);
  });

  it('should recursively merge nested objects', () => {
    const baseServicesWithUlimits: ServiceInput[] = [
      {
        name: 'app',
        image: 'app:latest',
        ulimits: { nofile: { soft: 1024, hard: 2048 } },
      },
    ];
    const overrides = [
      {
        architecture: 'amd64' as Architecture,
        services: [{ name: 'app', ulimits: { nofile: { soft: 4096 } } }],
      },
    ];

    const result = mergeArchitectureOverrides(baseServicesWithUlimits, overrides, 'amd64');

    expect(result[0]?.ulimits).toEqual({ nofile: { soft: 4096, hard: 2048 } });
  });

  it('should ignore prototype-polluting keys from an override', () => {
    const services: ServiceInput[] = [{ name: 'app', image: 'app:latest', sysctls: { safe: 1 } }];
    const overrides = JSON.parse(
      '{"architecture":"amd64","services":[{"name":"app","sysctls":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}}]}',
    );

    const result = mergeArchitectureOverrides(services, overrides, 'amd64');
    const sysctls = result[0]?.sysctls ?? {};

    expect(Object.getPrototypeOf(sysctls)).toBe(Object.prototype);
    expect(Object.hasOwn(sysctls, '__proto__')).toBe(false);
    expect(Object.hasOwn(sysctls, 'constructor')).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('should handle multiple architecture overrides', () => {
    const overrides = [
      {
        architecture: 'arm64' as Architecture,
        services: [
          {
            name: 'app',
            image: 'app:arm64-latest',
          },
        ],
      },
      {
        architecture: 'amd64' as Architecture,
        services: [
          {
            name: 'app',
            image: 'app:amd64-latest',
          },
        ],
      },
    ];

    const arm64Result = mergeArchitectureOverrides(baseServices, overrides, 'arm64');
    expect(arm64Result[0]?.image).toEqual('app:arm64-latest');

    const amd64Result = mergeArchitectureOverrides(baseServices, overrides, 'amd64');
    expect(amd64Result[0]?.image).toEqual('app:amd64-latest');
  });

  it('should ignore services in overrides that are not in base services', () => {
    const overrides = [
      {
        architecture: 'amd64' as Architecture,
        services: [
          {
            name: 'nonexistent',
            image: 'nonexistent:latest',
          },
        ],
      },
    ];

    const result = mergeArchitectureOverrides(baseServices, overrides, 'amd64');
    expect(result).toEqual(baseServices);
  });

  it('should ignore overrides without a name property', () => {
    const overrides = [
      {
        architecture: 'amd64' as Architecture,
        services: [
          {
            image: 'app:amd64-latest',
          },
        ],
      },
    ];

    const result = mergeArchitectureOverrides(baseServices, overrides, 'amd64');
    expect(result).toEqual(baseServices);
  });
});
