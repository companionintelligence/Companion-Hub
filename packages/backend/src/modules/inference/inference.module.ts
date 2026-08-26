import { Module, forwardRef } from '@nestjs/common';
import { LoggerModule } from '@/core/logger/logger.module';
import { FilesystemModule } from '@/core/filesystem/filesystem.module';
import { SystemModule } from '@/modules/system/system.module';
import { HardwareInspectorService } from './hardware-inspector.service';
import { ModelRegistryService } from './model-registry.service';
import { MemoryManagerService } from './memory-manager.service';
import { ModelPullerService } from './model-puller.service';
import { InferenceRouterService } from './inference-router.service';
import { CloudFallbackService } from './cloud-fallback.service';
import { OllamaInstallerService } from './ollama-installer.service';
import { RocmInstallerService } from './rocm-installer.service';
import { AppCredentialsService } from './app-credentials.service';
import { InferenceEnvResolver } from './inference-env-resolver';
import { OllamaBackend } from './backends/ollama.backend';
import { VllmBackend } from './backends/vllm.backend';
import { LemonadeBackend } from './backends/lemonade.backend';
import { DsparkBackend } from './backends/dspark.backend';
import { InferenceController } from './inference.controller';

@Module({
  imports: [LoggerModule, FilesystemModule, forwardRef(() => SystemModule)],
  controllers: [InferenceController],
  providers: [
    HardwareInspectorService,
    ModelRegistryService,
    MemoryManagerService,
    ModelPullerService,
    InferenceRouterService,
    CloudFallbackService,
    OllamaInstallerService,
    RocmInstallerService,
    AppCredentialsService,
    InferenceEnvResolver,
    OllamaBackend,
    VllmBackend,
    LemonadeBackend,
    DsparkBackend,
  ],
  exports: [
    HardwareInspectorService,
    ModelRegistryService,
    MemoryManagerService,
    ModelPullerService,
    InferenceRouterService,
    CloudFallbackService,
    OllamaInstallerService,
    RocmInstallerService,
    AppCredentialsService,
    InferenceEnvResolver,
    OllamaBackend,
    VllmBackend,
    LemonadeBackend,
    DsparkBackend,
  ],
})
export class InferenceModule {}
