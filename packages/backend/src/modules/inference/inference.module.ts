import { Module, forwardRef } from '@nestjs/common';
import { LoggerModule } from '@/core/logger/logger.module';
import { FilesystemModule } from '@/core/filesystem/filesystem.module';
import { SystemModule } from '@/modules/system/system.module';
import { DockerModule } from '@/modules/docker/docker.module';
import { HubPoolModule } from '@/modules/hub-pool/hub-pool.module';
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
import { AppCredentialsService } from './app-credentials.service';
import { InferenceEnvResolver } from './inference-env-resolver';
import { InferenceEndpointService } from './inference-endpoint.service';
import { InferenceBackendRegistry } from './backends/backend-registry';
import { OllamaBackend } from './backends/ollama.backend';
import { VllmBackend } from './backends/vllm.backend';
import { LemonadeBackend } from './backends/lemonade.backend';
import { MtplxBackend } from './backends/mtplx.backend';
import { DsparkBackend } from './backends/dspark.backend';
import { LuceboxBackend } from './backends/lucebox.backend';
import { LlamacppBackend } from './backends/llamacpp.backend';
import { LmStudioBackend } from './backends/lmstudio.backend';
import { BackendObserverService } from './supervision/backend-observer.service';
import { InferenceController } from './inference.controller';

@Module({
  // DockerModule needs no forwardRef: its own import graph is `AppsDataModule` alone, which imports
  // nothing, so there is no cycle back to inference. (SystemModule does forwardRef DockerModule, but
  // that edge is SystemModule's, not this one's.)
  imports: [LoggerModule, FilesystemModule, DockerModule, forwardRef(() => SystemModule), forwardRef(() => HubPoolModule)],
  controllers: [InferenceController],
  providers: [
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
    MtplxBackend,
    DsparkBackend,
    LuceboxBackend,
    LlamacppBackend,
    LmStudioBackend,
    InferenceBackendRegistry,
    BackendObserverService,
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
    MtplxBackend,
    DsparkBackend,
    LuceboxBackend,
    LlamacppBackend,
    LmStudioBackend,
    InferenceBackendRegistry,
    BackendObserverService,
  ],
})
export class InferenceModule {}
