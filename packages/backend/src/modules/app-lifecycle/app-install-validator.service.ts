import { TranslatableError } from '@/common/error/translatable-error';
import { ConfigurationService } from '@/core/config/configuration.service';
import { Injectable } from '@nestjs/common';
import type { appFormSchema } from './dto/app-lifecycle.dto';
import type { z } from 'zod';
import validator from 'validator';
import { publishesHostPort } from '../apps/app-exposure.helpers';
import { AppsRepository } from '../apps/apps.repository';

type ParsedInstallForm = z.infer<typeof appFormSchema>;

@Injectable()
export class AppInstallValidator {
  constructor(
    private readonly appRepository: AppsRepository,
    private readonly config: ConfigurationService,
  ) {}

  assertDemoInstallLimit(installedCount: number): void {
    if (this.config.get('demoMode') && installedCount >= 6) {
      throw new TranslatableError('SYSTEM_ERROR_DEMO_MODE_LIMIT');
    }
  }

  assertDomainRules(parsedForm: ParsedInstallForm): void {
    const { isProduction } = this.config.getConfig();

    if (isProduction && parsedForm.exposed) {
      parsedForm.exposed = false;
      parsedForm.domain = undefined;
    }

    const { exposed, domain } = parsedForm;

    if (exposed && !domain) {
      throw new TranslatableError('APP_ERROR_DOMAIN_REQUIRED_IF_EXPOSE_APP');
    }

    if (domain && !validator.isFQDN(domain)) {
      throw new TranslatableError('APP_ERROR_DOMAIN_NOT_VALID', { domain });
    }
  }

  async assertNoRoutingConflicts(params: { parsedForm: ParsedInstallForm; existingAppId?: number; routingSubdomain: string | null }): Promise<void> {
    const { parsedForm, existingAppId, routingSubdomain } = params;
    const { exposed, domain, port } = parsedForm;

    const conflictsOtherApp = <T extends { id?: number }>(candidates: T[]) =>
      existingAppId ? candidates.filter((candidate) => candidate.id !== existingAppId) : candidates;

    if (exposed && domain) {
      const appsWithSameDomain = conflictsOtherApp(await this.appRepository.getAppsByDomain(domain));
      if (appsWithSameDomain.length > 0) {
        throw new TranslatableError('APP_ERROR_DOMAIN_ALREADY_IN_USE', { domain, id: appsWithSameDomain[0]?.appName });
      }
    }

    if (routingSubdomain) {
      const appsWithSameLocalSubdomain = conflictsOtherApp(await this.appRepository.getAppsByLocalSubdomain(routingSubdomain));
      if (appsWithSameLocalSubdomain.length > 0) {
        throw new TranslatableError('APP_ERROR_LOCAL_SUBDOMAIN_ALREADY_IN_USE', {
          subdomain: routingSubdomain,
          id: appsWithSameLocalSubdomain[0]?.appName,
        });
      }
    }

    if (publishesHostPort(parsedForm) && port) {
      const appsWithSamePort = conflictsOtherApp(await this.appRepository.getAppsByPort(port));
      if (appsWithSamePort.length > 0) {
        throw new TranslatableError('APP_ERROR_PORT_ALREADY_IN_USE', { port: port.toString(), id: appsWithSamePort[0]?.appName });
      }
    }
  }
}
