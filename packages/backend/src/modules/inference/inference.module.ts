import { Module, forwardRef } from '@nestjs/common';
import { LoggerModule } from '@/core/logger/logger.module';
import { InternalOriginGuard } from '@/modules/auth/internal-origin.guard';
import { FilesystemModule } from '@/core/filesystem/filesystem.module';
import { SystemModule } from '@/modules/system/system.module';
import { DockerModule } from '@/modules/docker/docker.module';
import { AppsDataModule } from '@/modules/apps/apps-data.module';
import { HubPoolModule } from '@/modules/hub-pool/hub-pool.module';
import { ApiKeyModule } from '@/modules/api-keys/api-key.module';
import { InferenceAccessGuard } from '@/modules/auth/inference-access.guard';
import { HardwareInspectorService } from './hardware-inspector.service';
import { GpuProcessSamplerService } from './gpu-process-sampler.service';
import { ModelRegistryService } from './model-registry.service';
import { ModelResidencyService } from './model-residency.service';
import { MemoryManagerService } from './memory-manager.service';
import { ModelPullerService } from './model-puller.service';
import { InferenceRouterService } from './inference-router.service';
import { CloudFallbackService } from './cloud-fallback.service';
import { OllamaInstallerService } from './ollama-installer.service';
import { RocmInstallerService } from './rocm-installer.service';
import { AppContainerOriginGuard } from './app-container-origin.guard';
import { AppCredentialsService } from './app-credentials.service';
import { InferenceEnvResolver } from './inference-env-resolver';
import { InferenceEndpointService } from './inference-endpoint.service';
import { InferenceBackendRegistry } from './backends/backend-registry';
import { OllamaBackend } from './backends/ollama.backend';
import { VllmBackend } from './backends/vllm.backend';
import { LemonadeBackend } from './backends/lemonade.backend';
import { OmlxBackend } from './backends/omlx.backend';
import { BackendObserverService } from './supervision/backend-observer.service';
import { InferenceController } from './inference.controller';

@Module({
  // DockerModule needs no forwardRef: its own import graph is `AppsDataModule` alone, which imports
  // nothing, so there is no cycle back to inference. (SystemModule does forwardRef DockerModule, but
  // that edge is SystemModule's, not this one's.) ApiKeyModule likewise: it imports only LoggerModule
  // and the global database module, and InferenceAccessGuard's key leg needs its ApiKeyService.
  // AppsDataModule, for the same reason as DockerModule's import of it, is cycle-free: the router
  // reads installed apps' context floors through its AppsRepository when it sizes a Lemonade load.
  imports: [
    LoggerModule,
    FilesystemModule,
    DockerModule,
    AppsDataModule,
    ApiKeyModule,
    forwardRef(() => SystemModule),
    forwardRef(() => HubPoolModule),
  ],
  controllers: [InferenceController],
  providers: [
    InferenceAccessGuard,
    HardwareInspectorService,
    GpuProcessSamplerService,
    ModelRegistryService,
    ModelResidencyService,
    MemoryManagerService,
    ModelPullerService,
    InferenceRouterService,
    CloudFallbackService,
    OllamaInstallerService,
    RocmInstallerService,
    AppCredentialsService,
    InferenceEnvResolver,
    InferenceEndpointService,
    OllamaBackend,
    VllmBackend,
    LemonadeBackend,
    OmlxBackend,
    InferenceBackendRegistry,
    BackendObserverService,
    InternalOriginGuard,
    AppContainerOriginGuard,
  ],
  exports: [
    HardwareInspectorService,
    GpuProcessSamplerService,
    ModelRegistryService,
    ModelResidencyService,
    MemoryManagerService,
    ModelPullerService,
    InferenceRouterService,
    CloudFallbackService,
    OllamaInstallerService,
    RocmInstallerService,
    AppCredentialsService,
    InferenceEnvResolver,
    InferenceEndpointService,
    OllamaBackend,
    VllmBackend,
    LemonadeBackend,
    OmlxBackend,
    InferenceBackendRegistry,
    BackendObserverService,
  ],
})
export class InferenceModule {}
