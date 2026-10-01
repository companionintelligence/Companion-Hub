import { faker } from '@faker-js/faker';
import { beforeEach, describe, expect, it } from 'vitest';
import { ServiceBuilder } from '../service.builder';

describe('ServiceBuilder', () => {
  let serviceBuilder: ServiceBuilder;

  beforeEach(() => {
    serviceBuilder = new ServiceBuilder();
  });

  it('should build a service', () => {
    const name = faker.lorem.word();
    const image = faker.lorem.word();
    const service = serviceBuilder.setName(name).setImage(image).build();

    expect(service).not.toHaveProperty('container_name');
    expect(service).toHaveProperty('image', image);
  });

  it('should throw an error if the name is not set', () => {
    const image = faker.lorem.word();
    serviceBuilder.setImage(image);

    expect(() => serviceBuilder.build()).toThrowError();
  });

  it('should throw an error if the image is not set', () => {
    const name = faker.lorem.word();
    serviceBuilder.setName(name);

    expect(() => serviceBuilder.build()).toThrowError();
  });

  it('if network_mode is set, it should remove the network and ports', () => {
    const networkMode = faker.lorem.word();
    const service = serviceBuilder
      .setNetworkMode(networkMode)
      .setName('name')
      .setImage('image')
      .setPort({ containerPort: 80, hostPort: 80 })
      .setNetwork('network')
      .build();

    expect(service).toHaveProperty('network_mode', networkMode);
    expect(service).not.toHaveProperty('ports');
    expect(service).not.toHaveProperty('networks');
  });

  describe('interpolateVariables', () => {
    it('should replace RUNCIHUB_APP_ID in label values', () => {
      const service = serviceBuilder
        .setName('name')
        .setImage('image')
        .setLabels({ 'runcihub.app_id': '{{RUNCIHUB_APP_ID}}' })
        .interpolateVariables('my-app')
        .build();

      expect(service.labels).toEqual({ 'runcihub.app_id': 'my-app' });
    });

    it('should replace RUNCIHUB_APP_ID in label keys', () => {
      const service = serviceBuilder
        .setName('name')
        .setImage('image')
        .setLabels({ '{{RUNCIHUB_APP_ID}}': 'value' })
        .interpolateVariables('my-app')
        .build();

      expect(service.labels).toEqual({ 'my-app': 'value' });
    });

    it('should replace RUNCIHUB_APP_ID in both keys and values', () => {
      const service = serviceBuilder
        .setName('name')
        .setImage('image')
        .setLabels({ '{{RUNCIHUB_APP_ID}}': '{{RUNCIHUB_APP_ID}}' })
        .interpolateVariables('my-app')
        .build();

      expect(service.labels).toEqual({ 'my-app': 'my-app' });
    });

    it('should handle spaces in the placeholder', () => {
      const service = serviceBuilder
        .setName('name')
        .setImage('image')
        .setLabels({ '{{ RUNCIHUB_APP_ID }}': '{{ RUNCIHUB_APP_ID }}' })
        .interpolateVariables('my-app')
        .build();

      expect(service.labels).toEqual({ 'my-app': 'my-app' });
    });

    it('should handle multiple replacements in the same value', () => {
      const service = serviceBuilder
        .setName('name')
        .setImage('image')
        .setLabels({ test: '{{RUNCIHUB_APP_ID}}-{{RUNCIHUB_APP_ID}}' })
        .interpolateVariables('my-app')
        .build();

      expect(service.labels).toEqual({ test: 'my-app-my-app' });
    });

    // The catalog's own manifests use {{RUNTIPI_APP_ID}} — #1143 (c88a83580) renamed the
    // legacy branch of this pattern to RUNCIHUB_APP_ID by substring, a spelling no manifest
    // has ever contained, so real labels stopped interpolating and shipped as literals.
    it('should replace RUNTIPI_APP_ID — the placeholder real catalog manifests use', () => {
      const service = serviceBuilder
        .setName('name')
        .setImage('image')
        .setLabels({ 'runtipi.app_id': '{{RUNTIPI_APP_ID}}' })
        .interpolateVariables('my-app')
        .build();

      expect(service.labels).toEqual({ 'runtipi.app_id': 'my-app' });
    });

    it('should replace RUNTIPI_APP_ID in label keys', () => {
      const service = serviceBuilder
        .setName('name')
        .setImage('image')
        .setLabels({ '{{RUNTIPI_APP_ID}}': 'value' })
        .interpolateVariables('my-app')
        .build();

      expect(service.labels).toEqual({ 'my-app': 'value' });
    });

    it('should handle spaces in a RUNTIPI_APP_ID placeholder', () => {
      const service = serviceBuilder
        .setName('name')
        .setImage('image')
        .setLabels({ '{{ RUNTIPI_APP_ID }}': '{{ RUNTIPI_APP_ID }}' })
        .interpolateVariables('my-app')
        .build();

      expect(service.labels).toEqual({ 'my-app': 'my-app' });
    });

    it('should replace every placeholder spelling side by side', () => {
      const service = serviceBuilder
        .setName('name')
        .setImage('image')
        .setLabels({ test: '{{CI_HUB_APP_ID}}-{{RUNTIPI_APP_ID}}-{{RUNCIHUB_APP_ID}}' })
        .interpolateVariables('my-app')
        .build();

      expect(service.labels).toEqual({ test: 'my-app-my-app-my-app' });
    });
  });

  describe('Volume Mount Propagation', () => {
    let service: ServiceBuilder;

    beforeEach(() => {
      service = new ServiceBuilder().setName('test').setImage('test');
    });

    describe('New bind mount propagation', () => {
      it('should handle rshared propagation mode', () => {
        const built = service
          .setVolume({
            hostPath: '/host',
            containerPath: '/container',
            bind: { propagation: 'rshared' },
          })
          .build();

        expect(built.volumes).toEqual([
          {
            type: 'bind',
            source: '/host',
            target: '/container',
            bind: { propagation: 'rshared' },
          },
        ]);
      });

      it('should handle shared propagation mode', () => {
        const built = service
          .setVolume({
            hostPath: '/host',
            containerPath: '/container',
            bind: { propagation: 'shared' },
          })
          .build();

        expect(built.volumes).toEqual([
          {
            type: 'bind',
            source: '/host',
            target: '/container',
            bind: { propagation: 'shared' },
          },
        ]);
      });

      it('should handle private propagation mode', () => {
        const built = service
          .setVolume({
            hostPath: '/host',
            containerPath: '/container',
            bind: { propagation: 'private' },
          })
          .build();

        expect(built.volumes).toEqual([
          {
            type: 'bind',
            source: '/host',
            target: '/container',
            bind: { propagation: 'private' },
          },
        ]);
      });

      it('should handle rprivate propagation mode', () => {
        const built = service
          .setVolume({
            hostPath: '/host',
            containerPath: '/container',
            bind: { propagation: 'rprivate' },
          })
          .build();

        expect(built.volumes).toEqual([
          {
            type: 'bind',
            source: '/host',
            target: '/container',
            bind: { propagation: 'rprivate' },
          },
        ]);
      });

      it('should handle rslave propagation mode', () => {
        const built = service
          .setVolume({
            hostPath: '/host',
            containerPath: '/container',
            bind: { propagation: 'rslave' },
          })
          .build();

        expect(built.volumes).toEqual([
          {
            type: 'bind',
            source: '/host',
            target: '/container',
            bind: { propagation: 'rslave' },
          },
        ]);
      });

      it('should handle slave propagation mode', () => {
        const built = service
          .setVolume({
            hostPath: '/host',
            containerPath: '/container',
            bind: { propagation: 'slave' },
          })
          .build();

        expect(built.volumes).toEqual([
          {
            type: 'bind',
            source: '/host',
            target: '/container',
            bind: { propagation: 'slave' },
          },
        ]);
      });

      it('should combine readOnly with bind propagation', () => {
        const built = service
          .setVolume({
            hostPath: '/host',
            containerPath: '/container',
            readOnly: true,
            bind: { propagation: 'rshared' },
          })
          .build();

        expect(built.volumes).toEqual([
          {
            type: 'bind',
            source: '/host',
            target: '/container',
            read_only: true,
            bind: { propagation: 'rshared' },
          },
        ]);
      });
    });

    describe('Basic volume mounts', () => {
      it('should handle basic volume without any flags', () => {
        const built = service.setVolume({ hostPath: '/host', containerPath: '/container' }).build();

        expect(built.volumes).toEqual(['/host:/container']);
      });

      it('should handle readOnly alone', () => {
        const built = service.setVolume({ hostPath: '/host', containerPath: '/container', readOnly: true }).build();

        expect(built.volumes).toEqual(['/host:/container:ro']);
      });
    });

    describe('Named volumes', () => {
      it('mounts a named volume as the source', () => {
        const built = service.setVolume({ volumeName: 'pgdata', containerPath: '/var/lib/postgresql' }).build();

        expect(built.volumes).toEqual(['pgdata:/var/lib/postgresql']);
      });

      it('honours readOnly on a named volume', () => {
        const built = service.setVolume({ volumeName: 'config', containerPath: '/config', readOnly: true }).build();

        expect(built.volumes).toEqual(['config:/config:ro']);
      });

      it('ignores bind propagation on a named volume, which has no host mount to propagate', () => {
        const built = service.setVolume({ volumeName: 'pgdata', containerPath: '/data', bind: { propagation: 'rshared' } }).build();

        expect(built.volumes).toEqual(['pgdata:/data']);
      });

      // Rendering the service without the mount would be the dangerous outcome: it starts, writes
      // to the container layer, and loses the data on the next recreate. Failing the build keeps
      // the bad manifest visible.
      it('refuses a volume that names neither a host path nor a volume', () => {
        expect(() => service.setVolume({ containerPath: '/container' })).toThrow(/neither hostPath nor volumeName/);
      });

      // Picking one silently (the `??` would take volumeName) mounts something the manifest never
      // unambiguously asked for, and hides the mistake behind a working-looking app.
      it('refuses a volume that names both a host path and a volume', () => {
        expect(() => service.setVolume({ containerPath: '/container', hostPath: '/host', volumeName: 'pgdata' })).toThrow(
          /both hostPath and volumeName/,
        );
      });

      // The redirect path clears hostPath rather than deleting the key; the guard must read that
      // as "no host path" or every redirected database volume would fail to build.
      it('accepts a redirected volume whose hostPath key is present but undefined', () => {
        service.setVolume({ containerPath: '/data', hostPath: undefined, volumeName: 'pgdata' });
        expect(service.build().volumes).toEqual(['pgdata:/data']);
      });
    });
  });
  describe('Port protocols', () => {
    // A regression upstream broke exactly this: a UDP-only port was written out as TCP, so a
    // DNS or game server was published on the wrong protocol and nothing reached it.
    let service: ServiceBuilder;

    beforeEach(() => {
      service = new ServiceBuilder().setName('svc').setImage('image');
    });

    it('publishes a port with no protocol flag as a plain mapping, which Docker reads as TCP', () => {
      service.setPort({ containerPort: 80, hostPort: 8080 });
      expect(service.build().ports).toEqual(['8080:80']);
    });

    it('publishes a TCP-only port with an explicit /tcp', () => {
      service.setPort({ containerPort: 80, hostPort: 8080, tcp: true });
      expect(service.build().ports).toEqual(['8080:80/tcp']);
    });

    it('publishes a UDP-only port as /udp and not as TCP', () => {
      service.setPort({ containerPort: 53, hostPort: 53, udp: true });
      expect(service.build().ports).toEqual(['53:53/udp']);
    });

    it('publishes a port that needs both protocols once for each', () => {
      service.setPort({ containerPort: 53, hostPort: 53, tcp: true, udp: true });
      expect(service.build().ports).toEqual(['53:53/tcp', '53:53/udp']);
    });

    it('keeps the bind interface in front of the mapping for each protocol', () => {
      service.setPort({ containerPort: 53, hostPort: 53, tcp: true, udp: true, interface: '127.0.0.1' });
      expect(service.build().ports).toEqual(['127.0.0.1:53:53/tcp', '127.0.0.1:53:53/udp']);
    });

    it('passes a port written as an environment reference or a range through untouched', () => {
      service.setPort({ containerPort: '${APP_PORT}' as never, hostPort: '${APP_PORT}' as never, udp: true });
      service.setPort({ containerPort: '8000-8010' as never, hostPort: '8000-8010' as never });
      expect(service.build().ports).toEqual(['${APP_PORT}:${APP_PORT}/udp', '8000-8010:8000-8010']);
    });
  });
});
