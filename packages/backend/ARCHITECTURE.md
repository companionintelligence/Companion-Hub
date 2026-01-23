# CI-OS-Hub Backend Architecture

This document outlines the happy path flows for the CI-OS-Hub backend.

## Happy Path Flow Diagram

The following sequence diagram illustrates the three key phases of user interaction: Device Registration, Account Creation, and App Installation.

```mermaid
sequenceDiagram
    participant User
    participant Frontend
    participant CI_Cloud as CI Cloud
    participant RegCtrl as RegistrationController
    participant RegSvc as RegistrationService
    participant AuthCtrl as AuthController
    participant AuthSvc as AuthService
    participant UserRepo as UserRepository
    participant AppLifeCtrl as AppLifecycleController
    participant AppLifeSvc as AppLifecycleService
    participant AppRepo as AppsRepository
    participant Queue as AppEventsQueue (BullMQ)
    participant Worker as CommandWorker
    participant Market as MarketplaceService
    participant Docker as DockerService (Dockerode)
    participant Cloudflared as Cloudflared Container
    participant Traefik as Traefik Container

    %% Phase 1: Device Registration
    rect rgb(230, 240, 255)
    note over User, Traefik: Phase 1: Device Registration
    User->>Frontend: 1. Start Registration
    Frontend->>RegCtrl: GET /registration/device-id
    RegCtrl->>RegSvc: getDeviceId()
    RegSvc-->>RegCtrl: Returns unique device ID
    RegCtrl-->>Frontend: Returns { registration_url, callback_url }
    
    Frontend->>CI_Cloud: Redirect to CI Cloud Auth
    activate CI_Cloud
    note right of CI_Cloud: User authenticates &<br/>selects Organization
    CI_Cloud->>RegCtrl: Redirect /registration/callback<br/>(org_id, tunnel_token, subdomain, etc.)
    deactivate CI_Cloud
    
    RegCtrl->>RegSvc: completeRegistrationFromCallback()
    RegSvc->>RegSvc: Save API Key & Org ID (UserConfig)
    RegSvc->>RegSvc: setupOrganizationInfrastructure()
    activate RegSvc
    RegSvc->>Docker: initializeTunnel(token)
    Docker->>Cloudflared: Write ./tunnel/token
    Docker->>Cloudflared: Restart Container
    deactivate RegSvc
    
    RegSvc-->>RegCtrl: Registration Success
    RegCtrl-->>Frontend: Redirect to Dashboard
    end

    %% Phase 2: Account Creation
    rect rgb(230, 255, 235)
    note over User, Traefik: Phase 2: Account Creation (First User)
    User->>Frontend: 2. Submit Setup Form (Email/Pass)
    Frontend->>AuthCtrl: POST /auth/register
    AuthCtrl->>AuthSvc: register(email, password)
    
    AuthSvc->>UserRepo: check no operators exist
    AuthSvc->>UserRepo: createUser(operator=true)
    AuthSvc->>AuthSvc: Create Session
    
    AuthSvc-->>AuthCtrl: Returns Session ID
    AuthCtrl-->>Frontend: Set-Cookie & Success Response
    end

    %% Phase 3: App Installation & Exposure
    rect rgb(255, 245, 230)
    note over User, Traefik: Phase 3: App Installation
    User->>Frontend: 3. Click "Install App"
    Frontend->>AppLifeCtrl: POST /app-lifecycle/:urn/install
    AppLifeCtrl->>AppLifeSvc: installApp(urn, config)
    
    activate AppLifeSvc
    AppLifeSvc->>Market: Validate App Info & Config
    AppLifeSvc->>AppRepo: createApp(status: 'installing')
    AppLifeSvc->>Queue: Publish Job { command: 'install', urn }
    AppLifeSvc-->>AppLifeCtrl: Returns Request ID (Async)
    deactivate AppLifeSvc
    AppLifeCtrl-->>Frontend: ACK (Websocket listens for updates)

    activate Queue
    Queue->>Worker: Process 'install' Job
    activate Worker
    Worker->>Market: getDockerComposeJson(urn)
    Worker->>Market: copyAppFromRepoToInstalled()
    Worker->>Market: copyDataDir() (Default configs)
    Worker->>Docker: pull() (docker-compose pull)
    Worker->>Docker: up() (docker-compose up -d)
    note right of Docker: App Container starts with<br/>Traefik labels
    Worker-->>Queue: Job Complete
    deactivate Worker
    deactivate Queue

    Queue->>AppLifeSvc: On Job Success
    AppLifeSvc->>AppRepo: updateApp(status: 'running')
    AppLifeSvc->>Frontend: SSE Event: 'install_success'
    
    %% Implicit Phase 4: Exposure Sync
    AppLifeSvc->>AppLifeSvc: triggerCloudflareSync()
    activate AppLifeSvc
    AppLifeSvc->>CI_Cloud: POST /tunnels/state (Exposed Apps Map)
    note right of CI_Cloud: Updates Cloudflare Ingress Rules<br/>(Remote Config)
    deactivate AppLifeSvc
    
    note over User, Traefik: Data Flow: User -> Cloudflare -> Tunnel -> Cloudflared -> Traefik -> App
    end
```

## Module Descriptions

### Core Layer
- **ConfigurationModule**: Manages environment variables and application config.
- **DatabaseModule**: Handles database connections (PostgreSQL/SQLite via Drizzle).
- **CacheModule**: Provides caching services (Redis/Memory).
- **FilesystemModule**: Abstraction for file system operations.
- **QueueModule**: Manages background jobs (BullMQ).
- **SSEModule**: Handles Server-Sent Events for real-time frontend updates.

### Integration Layer
- **DockerModule**: Wrapper around `dockerode` to interact with the Docker daemon.
- **GithubModule**: Utilities for interacting with GitHub APIs (for app stores/updates).

### App Management Domain
- **AppsModule**: Manages the `App` entities, persistent state of installed applications.
- **AppLifecycleModule**: The orchestration engine. Handles installation, starting, stopping, and uninstalling apps. Coordinates with Docker and Nginx/Traefik.
- **MarketplaceModule**: Aggregates available apps from configured App Stores.
- **AppStoreModule**: Manages the sources (git repos) where apps are defined.
- **EnvModule**: Manages `.env` files and environment variable injection for apps.

### User & Auth Domain
- **AuthModule**: Authentication logic (JWT, Session).
- **UserModule**: User profile management.

### System & Operations
- **SystemModule**: Provides host system information (RAM, CPU, usage).
- **BackupsModule**: Manages full system backups and restores.
- **RegistrationModule**: Handles linking the instance to the CI-Cloud.
- **CloudflareModule**: Manages Cloudflare Tunnels for remote access.
