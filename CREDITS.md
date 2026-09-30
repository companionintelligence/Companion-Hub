# Credits

Companion Intelligence is built on the work of the open-source community.
This page names the projects we depend on directly, in rough order of how much
of this repository stands on them.

## 1. Foundation

**CI-Hub is derived from [Runtipi](https://github.com/runtipi/runtipi)**, and would not exist
without it. See [NOTICE.md](NOTICE.md) for the licence terms that govern that
derivation.

## 2. Core stack

The frameworks and libraries that define how this repository is built.

| | Project | Licence | What it does |
| :-: | --- | --- | --- |
| <img src="https://github.com/nestjs.png?size=40" width="20" height="20" alt=""> | [`@nestjs/core`](https://nestjs.com) | MIT | Nest - modern, fast, powerful node.js web framework (@core) |
| <img src="https://github.com/nestjs.png?size=40" width="20" height="20" alt=""> | [`@nestjs/common`](https://nestjs.com) | MIT | Nest - modern, fast, powerful node.js web framework (@common) |
| <img src="https://github.com/react.png?size=40" width="20" height="20" alt=""> | [`react`](https://react.dev/) | MIT | React is a JavaScript library for building user interfaces. |
| <img src="https://github.com/react.png?size=40" width="20" height="20" alt=""> | [`react-dom`](https://react.dev/) | MIT | React package for working with the DOM. |
| <img src="https://github.com/vitejs.png?size=40" width="20" height="20" alt=""> | [`vite`](https://vite.dev) | MIT | Native-ESM powered web dev build tool |
| <img src="https://github.com/microsoft.png?size=40" width="20" height="20" alt=""> | [`typescript`](https://www.typescriptlang.org/) | Apache-2.0 | TypeScript is a language for application scale JavaScript development |
| <img src="https://github.com/drizzle-team.png?size=40" width="20" height="20" alt=""> | [`drizzle-orm`](https://orm.drizzle.team) | Apache-2.0 | Drizzle ORM package for SQL databases |
| <img src="https://github.com/tauri-apps.png?size=40" width="20" height="20" alt=""> | [`tauri`](https://tauri.app/) | Apache-2.0 OR MIT | Make tiny, secure apps for all desktop platforms with Tauri |
| <img src="https://github.com/tauri-apps.png?size=40" width="20" height="20" alt=""> | [`@tauri-apps/api`](https://github.com/tauri-apps/tauri#readme) | Apache-2.0 OR MIT | Tauri API definitions |
| <img src="https://github.com/tailwindlabs.png?size=40" width="20" height="20" alt=""> | [`tailwindcss`](https://tailwindcss.com) | MIT | A utility-first CSS framework for rapidly building custom user interfaces. |
| <img src="https://github.com/colinhacks.png?size=40" width="20" height="20" alt=""> | [`zod`](https://zod.dev) | MIT | TypeScript-first schema declaration and validation library with static type inference |
| <img src="https://github.com/expressjs.png?size=40" width="20" height="20" alt=""> | [`express`](https://expressjs.com/) | MIT | Fast, unopinionated, minimalist web framework |

## 3. Runtime dependencies

| | Project | Licence | What it does |
| :-: | --- | --- | --- |
|  | [`@ci-hub/common`](https://github.com/companionintelligence/CI-Hub) | first-party (internal) |  |
| <img src="https://github.com/codemirror.png?size=40" width="20" height="20" alt=""> | [`@codemirror/lang-json`](https://github.com/codemirror/lang-json#readme) | MIT | JSON language support for the CodeMirror code editor |
|  | [`@codemirror/lang-markdown`](https://code.haverbeke.berlin/codemirror/lang-markdown) | MIT | Markdown language support for the CodeMirror code editor |
| <img src="https://github.com/react-hook-form.png?size=40" width="20" height="20" alt=""> | [`@hookform/resolvers`](https://react-hook-form.com) | MIT | React Hook Form validation resolvers: Yup, Joi, Superstruct, Zod, Vest, Class Validator, io- |
| <img src="https://github.com/modelcontextprotocol.png?size=40" width="20" height="20" alt=""> | [`@modelcontextprotocol/client`](https://modelcontextprotocol.io) | MIT | Model Context Protocol implementation for TypeScript - Client package |
| <img src="https://github.com/modelcontextprotocol.png?size=40" width="20" height="20" alt=""> | [`@modelcontextprotocol/node`](https://modelcontextprotocol.io) | MIT | Model Context Protocol implementation for TypeScript - Node.js middleware |
| <img src="https://github.com/modelcontextprotocol.png?size=40" width="20" height="20" alt=""> | [`@modelcontextprotocol/sdk`](https://modelcontextprotocol.io) | MIT | Model Context Protocol implementation for TypeScript |
| <img src="https://github.com/modelcontextprotocol.png?size=40" width="20" height="20" alt=""> | [`@modelcontextprotocol/server`](https://modelcontextprotocol.io) | MIT | Model Context Protocol implementation for TypeScript - Server package |
| <img src="https://github.com/nestjs.png?size=40" width="20" height="20" alt=""> | [`@nestjs/axios`](https://github.com/nestjs/axios#readme) | MIT | Nest - modern, fast, powerful node.js web framework (@axios) |
| <img src="https://github.com/nestjs.png?size=40" width="20" height="20" alt=""> | [`@nestjs/platform-express`](https://nestjs.com) | MIT | Nest - modern, fast, powerful node.js web framework (@platform-express) |
| <img src="https://github.com/nestjs.png?size=40" width="20" height="20" alt=""> | [`@nestjs/serve-static`](https://github.com/nestjs/serve-static#readme) | MIT | Nest - modern, fast, powerful node.js web framework (@serve-static) |
| <img src="https://github.com/nestjs.png?size=40" width="20" height="20" alt=""> | [`@nestjs/swagger`](https://github.com/nestjs/swagger#readme) | MIT | Nest - modern, fast, powerful node.js web framework (@swagger) |
| <img src="https://github.com/nestjs.png?size=40" width="20" height="20" alt=""> | [`@nestjs/terminus`](https://github.com/nestjs/terminus#readme) | MIT | Terminus integration provides readiness/liveness health checks for NestJS. |
| <img src="https://github.com/nestjs.png?size=40" width="20" height="20" alt=""> | [`@nestjs/throttler`](https://github.com/nestjs/throttler#readme) | MIT | A Rate-Limiting module for NestJS to work on Express, Fastify, Websockets, Socket.IO, and Gr |
| <img src="https://github.com/yeojz.png?size=40" width="20" height="20" alt=""> | [`@otplib/core`](https://otplib.yeojz.dev) | MIT | Core interfaces, types, and crypto abstraction for otplib |
| <img src="https://github.com/yeojz.png?size=40" width="20" height="20" alt=""> | [`@otplib/plugin-crypto`](https://yeojz.otplib.dev) | MIT | node crypto plugin for otplib |
| <img src="https://github.com/yeojz.png?size=40" width="20" height="20" alt=""> | [`@otplib/plugin-thirty-two`](https://yeojz.otplib.dev) | MIT | thirty-two plugin for otplib |
| <img src="https://github.com/radix-ui.png?size=40" width="20" height="20" alt=""> | [`@radix-ui/react-checkbox`](https://radix-ui.com/primitives) | MIT |  |
| <img src="https://github.com/radix-ui.png?size=40" width="20" height="20" alt=""> | [`@radix-ui/react-dialog`](https://radix-ui.com/primitives) | MIT |  |
| <img src="https://github.com/radix-ui.png?size=40" width="20" height="20" alt=""> | [`@radix-ui/react-dropdown-menu`](https://radix-ui.com/primitives) | MIT |  |
| <img src="https://github.com/radix-ui.png?size=40" width="20" height="20" alt=""> | [`@radix-ui/react-select`](https://radix-ui.com/primitives) | MIT |  |
| <img src="https://github.com/radix-ui.png?size=40" width="20" height="20" alt=""> | [`@radix-ui/react-slot`](https://radix-ui.com/primitives) | MIT |  |
| <img src="https://github.com/radix-ui.png?size=40" width="20" height="20" alt=""> | [`@radix-ui/react-switch`](https://radix-ui.com/primitives) | MIT |  |
| <img src="https://github.com/radix-ui.png?size=40" width="20" height="20" alt=""> | [`@radix-ui/react-tabs`](https://radix-ui.com/primitives) | MIT |  |
| <img src="https://github.com/remix-run.png?size=40" width="20" height="20" alt=""> | [`@react-router/node`](https://github.com/remix-run/react-router) | MIT | Node.js platform abstractions for React Router |
| <img src="https://github.com/getsentry.png?size=40" width="20" height="20" alt=""> | [`@sentry/nestjs`](https://github.com/getsentry/sentry-javascript) | MIT | Official Sentry SDK for NestJS |
| <img src="https://github.com/getsentry.png?size=40" width="20" height="20" alt=""> | [`@sentry/node`](https://github.com/getsentry/sentry-javascript) | MIT | Sentry Node SDK using OpenTelemetry for performance instrumentation |
| <img src="https://github.com/getsentry.png?size=40" width="20" height="20" alt=""> | [`@sentry/react`](https://github.com/getsentry/sentry-javascript) | MIT | Official Sentry SDK for React.js |
| <img src="https://github.com/TanStack.png?size=40" width="20" height="20" alt=""> | [`@tanstack/react-query`](https://tanstack.com/query) | MIT | Hooks for managing, caching and syncing asynchronous and remote data in React |
| <img src="https://github.com/tauri-apps.png?size=40" width="20" height="20" alt=""> | [`@tauri-apps/plugin-http`](https://github.com/tauri-apps/plugins-workspace#readme) | MIT OR Apache-2.0 | plugin-http |
| <img src="https://github.com/tauri-apps.png?size=40" width="20" height="20" alt=""> | [`@tauri-apps/plugin-opener`](https://github.com/tauri-apps/plugins-workspace#readme) | MIT OR Apache-2.0 | Open files and URLs using their default application. |
| <img src="https://github.com/tauri-apps.png?size=40" width="20" height="20" alt=""> | [`@tauri-apps/plugin-os`](https://github.com/tauri-apps/plugins-workspace#readme) | MIT OR Apache-2.0 | plugin-os |
| <img src="https://github.com/tauri-apps.png?size=40" width="20" height="20" alt=""> | [`@tauri-apps/plugin-store`](https://github.com/tauri-apps/plugins-workspace#readme) | MIT OR Apache-2.0 | Simple, persistent key-value store. |
| <img src="https://github.com/uidotdev.png?size=40" width="20" height="20" alt=""> | [`@uidotdev/usehooks`](https://github.com/uidotdev/usehooks#readme) | MIT | A collection of modern, server-safe React hooks – from the ui.dev team |
| <img src="https://github.com/uiwjs.png?size=40" width="20" height="20" alt=""> | [`@uiw/codemirror-theme-copilot`](https://uiwjs.github.io/react-codemirror/#/theme/data/copilot) | MIT | Theme copilot for CodeMirror. |
| <img src="https://github.com/uiwjs.png?size=40" width="20" height="20" alt=""> | [`@uiw/react-codemirror`](https://uiwjs.github.io/react-codemirror) | MIT | CodeMirror component for React. |
| <img src="https://github.com/ajv-validator.png?size=40" width="20" height="20" alt=""> | [`ajv`](https://ajv.js.org) | MIT | Another JSON Schema Validator |
| <img src="https://github.com/rburns.png?size=40" width="20" height="20" alt=""> | [`ansi-to-html`](https://github.com/rburns/ansi-to-html) | MIT | Convert ansi escaped text streams to html. |
| <img src="https://github.com/ranisalt.png?size=40" width="20" height="20" alt=""> | [`argon2`](https://github.com/ranisalt/node-argon2#readme) | MIT | An Argon2 library for Node |
| <img src="https://github.com/axios.png?size=40" width="20" height="20" alt=""> | [`axios`](https://axios-http.com) | MIT | Promise based HTTP client for the browser and node.js |
| <img src="https://github.com/atlassian.png?size=40" width="20" height="20" alt=""> | [`better-ajv-errors`](https://github.com/atlassian/better-ajv-errors#readme) | Apache-2.0 | JSON Schema validation for Human |
| <img src="https://github.com/chronotope.png?size=40" width="20" height="20" alt=""> | [`chrono`](https://github.com/chronotope/chrono) | MIT OR Apache-2.0 | Date and time library for Rust |
| <img src="https://github.com/joe-bell.png?size=40" width="20" height="20" alt=""> | [`class-variance-authority`](https://github.com/joe-bell/cva#readme) | Apache-2.0 | Class Variance Authority 🧬 |
| <img src="https://github.com/lukeed.png?size=40" width="20" height="20" alt=""> | [`clsx`](https://github.com/lukeed/clsx#readme) | MIT | A tiny (239B) utility for constructing className strings conditionally. |
| <img src="https://github.com/expressjs.png?size=40" width="20" height="20" alt=""> | [`cookie-parser`](https://github.com/expressjs/cookie-parser#readme) | MIT | Parse HTTP request cookies |
| <img src="https://github.com/TehShrike.png?size=40" width="20" height="20" alt=""> | [`deepmerge`](https://github.com/TehShrike/deepmerge) | MIT | A library for deep (recursive) merging of Javascript objects |
|  | [`dirs`](https://codeberg.org/dirs/dirs-rs) | MIT OR Apache-2.0 | A tiny low-level library that provides platform-specific standard locations of directories f |
| <img src="https://github.com/apocas.png?size=40" width="20" height="20" alt=""> | [`dockerode`](https://github.com/apocas/dockerode#readme) | Apache-2.0 | Docker Remote API module. |
| <img src="https://github.com/cure53.png?size=40" width="20" height="20" alt=""> | [`dompurify`](https://github.com/cure53/DOMPurify) | (MPL-2.0 OR Apache-2.0) | DOMPurify is a DOM-only, super-fast, uber-tolerant XSS sanitizer for HTML, MathML and SVG. I |
| <img src="https://github.com/motdotla.png?size=40" width="20" height="20" alt=""> | [`dotenv`](https://github.com/motdotla/dotenv#readme) | BSD-2-Clause | Loads environment variables from .env file |
| <img src="https://github.com/rust-cli.png?size=40" width="20" height="20" alt=""> | [`env_logger`](https://github.com/rust-cli/env_logger) | MIT OR Apache-2.0 | A logging implementation for log which is configured via an environment variable. |
| <img src="https://github.com/motiondivision.png?size=40" width="20" height="20" alt=""> | [`framer-motion`](https://github.com/motiondivision/motion#readme) | MIT | A simple and powerful JavaScript animation library |
| <img src="https://github.com/gtk-rs.png?size=40" width="20" height="20" alt=""> | [`gtk`](https://gtk-rs.org/) | MIT | Rust bindings for the GTK+ 3 library |
| <img src="https://github.com/i18next.png?size=40" width="20" height="20" alt=""> | [`i18next`](https://www.i18next.com) | MIT | i18next internationalization framework |
| <img src="https://github.com/i18next.png?size=40" width="20" height="20" alt=""> | [`i18next-browser-languagedetector`](https://github.com/i18next/i18next-browser-languageDetector) | MIT | language detector used in browser environment for i18next |
| <img src="https://github.com/i18next.png?size=40" width="20" height="20" alt=""> | [`i18next-fs-backend`](https://github.com/i18next/i18next-fs-backend) | MIT | i18next-fs-backend is a backend layer for i18next using in Node.js and for Deno to load tran |
| <img src="https://github.com/i18next.png?size=40" width="20" height="20" alt=""> | [`i18next-http-backend`](https://github.com/i18next/i18next-http-backend) | MIT | i18next-http-backend is a backend layer for i18next using in Node.js, in the browser and for |
| <img src="https://github.com/immerjs.png?size=40" width="20" height="20" alt=""> | [`immer`](https://github.com/immerjs/immer#readme) | MIT | Create your next immutable state by mutating the current one |
| <img src="https://github.com/omrilotan.png?size=40" width="20" height="20" alt=""> | [`isbot`](https://isbot.js.org) | Unlicense | 🤖/👨‍🦰 Recognise bots/crawlers/spiders using the user agent string. |
| <img src="https://github.com/isomorphic-git.png?size=40" width="20" height="20" alt=""> | [`isomorphic-git`](https://isomorphic-git.org/) | MIT | A pure JavaScript reimplementation of git for node and browsers |
| <img src="https://github.com/panva.png?size=40" width="20" height="20" alt=""> | [`jose`](https://github.com/panva/jose) | MIT | JWA, JWS, JWE, JWT, JWK, JWKS for Node.js, Browser, Cloudflare Workers, Deno, Bun, and other |
| <img src="https://github.com/auth0.png?size=40" width="20" height="20" alt=""> | [`jsonwebtoken`](https://github.com/auth0/node-jsonwebtoken#readme) | MIT | JSON Web Token implementation (symmetric and asymmetric) |
| <img src="https://github.com/EastSun5566.png?size=40" width="20" height="20" alt=""> | [`let-it-go`](https://eastsun5566.github.io/let-it-go/) | MIT | ❄️ Let your website snow instantly |
| <img src="https://github.com/rust-lang.png?size=40" width="20" height="20" alt=""> | [`libc`](https://github.com/rust-lang/libc) | MIT OR Apache-2.0 | Raw FFI bindings to platform libraries like libc. |
| <img src="https://github.com/rust-lang.png?size=40" width="20" height="20" alt=""> | [`log`](https://github.com/rust-lang/log) | MIT OR Apache-2.0 | A lightweight logging facade for Rust |
| <img src="https://github.com/Gamote.png?size=40" width="20" height="20" alt=""> | [`lottie-react`](https://lottiereact.com) | MIT | Lottie animations in React: one component for the easy path, the whole engine when you need  |
| <img src="https://github.com/lucide-icons.png?size=40" width="20" height="20" alt=""> | [`lucide-react`](https://lucide.dev) | ISC | A Lucide icon library package for React applications. |
| <img src="https://github.com/keepsimple1.png?size=40" width="20" height="20" alt=""> | [`mdns-sd`](https://github.com/keepsimple1/mdns-sd) | Apache-2.0 OR MIT | mDNS Service Discovery library with no async runtime dependency |
| <img src="https://github.com/lucaong.png?size=40" width="20" height="20" alt=""> | [`minisearch`](https://lucaong.github.io/minisearch/) | MIT | Tiny but powerful full-text search engine for browser and Node |
| <img src="https://github.com/node-cron.png?size=40" width="20" height="20" alt=""> | [`node-cron`](https://nodecron.com) | ISC | Job scheduling for Node.js with overlap prevention, distributed coordination, and background |
| <img src="https://github.com/openai.png?size=40" width="20" height="20" alt=""> | [`openai`](https://github.com/openai/openai-node#readme) | Apache-2.0 | The official TypeScript library for the OpenAI API |
| <img src="https://github.com/brianc.png?size=40" width="20" height="20" alt=""> | [`pg`](https://github.com/brianc/node-postgres) | MIT | PostgreSQL client - pure javascript & libpq with the same API |
| <img src="https://github.com/python-pillow.png?size=40" width="20" height="20" alt=""> | [`Pillow`](https://python-pillow.github.io) | MIT-CMU | Python Imaging Library (fork) |
|  | [`playwright`](https://pypi.org/project/playwright/) | Apache-2.0 | A high-level API to automate web browsers |
| <img src="https://github.com/lupomontero.png?size=40" width="20" height="20" alt=""> | [`psl`](https://github.com/lupomontero/psl#readme) | MIT | Domain name parser based on the Public Suffix List |
| <img src="https://github.com/zpao.png?size=40" width="20" height="20" alt=""> | [`qrcode.react`](http://zpao.github.io/qrcode.react) | ISC | React component to generate QR codes |
| <img src="https://github.com/cody-greene.png?size=40" width="20" height="20" alt=""> | [`rabbitmq-client`](https://github.com/cody-greene/node-rabbitmq-client) | MIT | Robust, typed, RabbitMQ (0-9-1) client library |
| <img src="https://github.com/rust-random.png?size=40" width="20" height="20" alt=""> | [`rand`](https://rust-random.github.io/book) | MIT OR Apache-2.0 | Random number generators and other randomness functionality. |
| <img src="https://github.com/bvaughn.png?size=40" width="20" height="20" alt=""> | [`react-error-boundary`](https://react-error-boundary-lib.vercel.app/) | MIT | Simple reusable React error boundary component |
| <img src="https://github.com/react-hook-form.png?size=40" width="20" height="20" alt=""> | [`react-hook-form`](https://react-hook-form.com) | MIT | Performant, flexible and extensible forms library for React Hooks |
| <img src="https://github.com/i18next.png?size=40" width="20" height="20" alt=""> | [`react-i18next`](https://github.com/i18next/react-i18next) | MIT | Internationalization for react done right. Using the i18next i18n ecosystem. |
| <img src="https://github.com/remarkjs.png?size=40" width="20" height="20" alt=""> | [`react-markdown`](https://github.com/remarkjs/react-markdown#readme) | MIT | React component to render markdown |
| <img src="https://github.com/remix-run.png?size=40" width="20" height="20" alt=""> | [`react-router`](https://github.com/remix-run/react-router) | MIT | Declarative routing for React |
| <img src="https://github.com/ndom91.png?size=40" width="20" height="20" alt=""> | [`react-timezone-select`](https://github.com/ndom91/react-timezone-select) | MIT | Usable, dynamic React Timezone Select |
| <img src="https://github.com/ReactTooltip.png?size=40" width="20" height="20" alt=""> | [`react-tooltip`](https://github.com/ReactTooltip/react-tooltip#readme) | MIT | react tooltip component |
| <img src="https://github.com/redis.png?size=40" width="20" height="20" alt=""> | [`redis`](https://github.com/redis/node-redis) | MIT | A modern, high performance Redis client |
| <img src="https://github.com/rbuckton.png?size=40" width="20" height="20" alt=""> | [`reflect-metadata`](https://github.com/rbuckton/reflect-metadata) | Apache-2.0 | Polyfill for Metadata Reflection API |
| <img src="https://github.com/rust-lang.png?size=40" width="20" height="20" alt=""> | [`regex`](https://github.com/rust-lang/regex) | MIT OR Apache-2.0 | An implementation of regular expressions for Rust. This implementation uses finite automata  |
| <img src="https://github.com/rehypejs.png?size=40" width="20" height="20" alt=""> | [`rehype-raw`](https://github.com/rehypejs/rehype-raw#readme) | MIT | rehype plugin to reparse the tree (and raw nodes) |
| <img src="https://github.com/remarkjs.png?size=40" width="20" height="20" alt=""> | [`remark-breaks`](https://github.com/remarkjs/remark-breaks#readme) | MIT | remark plugin to add break support, without needing spaces |
| <img src="https://github.com/remarkjs.png?size=40" width="20" height="20" alt=""> | [`remark-gfm`](https://github.com/remarkjs/remark-gfm#readme) | MIT | remark plugin to support GFM (autolink literals, footnotes, strikethrough, tables, tasklists |
| <img src="https://github.com/seanmonstar.png?size=40" width="20" height="20" alt=""> | [`reqwest`](https://github.com/seanmonstar/reqwest) | MIT OR Apache-2.0 | higher level HTTP client library |
| <img src="https://github.com/reactivex.png?size=40" width="20" height="20" alt=""> | [`rxjs`](https://rxjs.dev) | Apache-2.0 | Reactive Extensions for modern JavaScript |
| <img src="https://github.com/npm.png?size=40" width="20" height="20" alt=""> | [`semver`](https://github.com/npm/node-semver#readme) | ISC | The semantic version parser used by npm. |
| <img src="https://github.com/getsentry.png?size=40" width="20" height="20" alt=""> | [`sentry`](https://sentry.io/welcome/) | MIT | Sentry (sentry.io) client for Rust. |
| <img src="https://github.com/serde-rs.png?size=40" width="20" height="20" alt=""> | [`serde`](https://serde.rs) | MIT OR Apache-2.0 | A generic serialization/deserialization framework |
| <img src="https://github.com/serde-rs.png?size=40" width="20" height="20" alt=""> | [`serde_json`](https://github.com/serde-rs/json) | MIT OR Apache-2.0 | A JSON serialization file format |
| <img src="https://github.com/RustCrypto.png?size=40" width="20" height="20" alt=""> | [`sha2`](https://github.com/RustCrypto/hashes) | MIT OR Apache-2.0 | Pure Rust implementation of the SHA-2 hash function family including SHA-224, SHA-256, SHA-3 |
| <img src="https://github.com/simov.png?size=40" width="20" height="20" alt=""> | [`slugify`](https://github.com/simov/slugify) | MIT | Slugifies a String |
| <img src="https://github.com/emilkowalski.png?size=40" width="20" height="20" alt=""> | [`sonner`](https://sonner.emilkowal.ski/) | MIT | An opinionated toast component for React. |
| <img src="https://github.com/sebhildebrandt.png?size=40" width="20" height="20" alt=""> | [`systeminformation`](https://systeminformation.io) | MIT | Advanced, lightweight system and OS information library |
| <img src="https://github.com/dcastil.png?size=40" width="20" height="20" alt=""> | [`tailwind-merge`](https://github.com/dcastil/tailwind-merge) | MIT | Merge Tailwind CSS classes without style conflicts |
| <img src="https://github.com/tauri-apps.png?size=40" width="20" height="20" alt=""> | [`tauri-build`](https://tauri.app/) | Apache-2.0 OR MIT | build time code to pair with https://crates.io/crates/tauri |
| <img src="https://github.com/tauri-apps.png?size=40" width="20" height="20" alt=""> | [`tauri-plugin-deep-link`](https://github.com/tauri-apps/plugins-workspace) | Apache-2.0 OR MIT | Set your Tauri application as the default handler for an URL |
| <img src="https://github.com/tauri-apps.png?size=40" width="20" height="20" alt=""> | [`tauri-plugin-http`](https://github.com/tauri-apps/plugins-workspace) | Apache-2.0 OR MIT | Access an HTTP client written in Rust. |
| <img src="https://github.com/tauri-apps.png?size=40" width="20" height="20" alt=""> | [`tauri-plugin-notification`](https://github.com/tauri-apps/plugins-workspace) | Apache-2.0 OR MIT | Send desktop and mobile notifications on your Tauri application. |
| <img src="https://github.com/tauri-apps.png?size=40" width="20" height="20" alt=""> | [`tauri-plugin-opener`](https://github.com/tauri-apps/plugins-workspace) | Apache-2.0 OR MIT | Open files and URLs using their default application. |
| <img src="https://github.com/tauri-apps.png?size=40" width="20" height="20" alt=""> | [`tauri-plugin-os`](https://github.com/tauri-apps/plugins-workspace) | Apache-2.0 OR MIT | Read information about the operating system. |
| <img src="https://github.com/tauri-apps.png?size=40" width="20" height="20" alt=""> | [`tauri-plugin-single-instance`](https://github.com/tauri-apps/plugins-workspace) | Apache-2.0 OR MIT | Ensure a single instance of your tauri app is running. |
| <img src="https://github.com/tauri-apps.png?size=40" width="20" height="20" alt=""> | [`tauri-plugin-store`](https://github.com/tauri-apps/plugins-workspace) | Apache-2.0 OR MIT | Simple, persistent key-value store. |
| <img src="https://github.com/Stebalien.png?size=40" width="20" height="20" alt=""> | [`tempfile`](https://stebalien.com/projects/tempfile-rs/) | MIT OR Apache-2.0 | A library for managing temporary files and directories. |
| <img src="https://github.com/tokio-rs.png?size=40" width="20" height="20" alt=""> | [`tokio`](https://tokio.rs) | MIT | An event-driven, non-blocking I/O platform for writing asynchronous I/O backed applications. |
| <img src="https://github.com/privatenumber.png?size=40" width="20" height="20" alt=""> | [`tsx`](https://tsx.hirok.io) | MIT | TypeScript Execute (tsx): Node.js enhanced with esbuild to run TypeScript & ESM files |
| <img src="https://github.com/validatorjs.png?size=40" width="20" height="20" alt=""> | [`validator`](https://github.com/validatorjs/validator.js) | MIT | String validation and sanitization |
| <img src="https://github.com/web-push-libs.png?size=40" width="20" height="20" alt=""> | [`web-push`](https://github.com/web-push-libs/web-push#readme) | MPL-2.0 | Web Push library for Node.js |
| <img src="https://github.com/winstonjs.png?size=40" width="20" height="20" alt=""> | [`winston`](https://github.com/winstonjs/winston#readme) | MIT | A logger for just about everything. |
|  | [`yaml`](https://eemeli.org/yaml/) | ISC | JavaScript parser and stringifier for YAML |
| <img src="https://github.com/causaly.png?size=40" width="20" height="20" alt=""> | [`zod-validation-error`](https://github.com/causaly/zod-validation-error) | MIT | Wrap zod validation errors in user-friendly readable messages |
| <img src="https://github.com/pmndrs.png?size=40" width="20" height="20" alt=""> | [`zustand`](https://github.com/pmndrs/zustand) | MIT | 🐻 Bear necessities for state management in React |

## 4. Build and tooling

| | Project | Licence | What it does |
| :-: | --- | --- | --- |
| <img src="https://github.com/arethetypeswrong.png?size=40" width="20" height="20" alt=""> | [`@arethetypeswrong/cli`](https://github.com/arethetypeswrong/arethetypeswrong.github.io) | MIT | A CLI tool for arethetypeswrong.github.io |
| <img src="https://github.com/biomejs.png?size=40" width="20" height="20" alt=""> | [`@biomejs/biome`](https://biomejs.dev) | MIT OR Apache-2.0 | Biome is a toolchain for the web: formatter, linter and more |
| <img src="https://github.com/changesets.png?size=40" width="20" height="20" alt=""> | [`@changesets/cli`](https://changesets.dev) | MIT | A tool to manage versioning and changelogs with a focus on monorepos |
|  | [`@companionintelligence/video-kit`](https://github.com/companionintelligence/CI-Hub) | first-party (internal) |  |
| <img src="https://github.com/faker-js.png?size=40" width="20" height="20" alt=""> | [`@faker-js/faker`](https://fakerjs.dev) | MIT | Generate massive amounts of fake contextual data |
| <img src="https://github.com/hey-api.png?size=40" width="20" height="20" alt=""> | [`@hey-api/openapi-ts`](https://heyapi.dev/docs/openapi/typescript/get-started) | MIT | 🌀 OpenAPI to TypeScript code generator. Production-grade SDKs, Zod schemas, TanStack Query  |
| <img src="https://github.com/nestjs.png?size=40" width="20" height="20" alt=""> | [`@nestjs/cli`](https://github.com/nestjs/nest-cli#readme) | MIT | Nest - modern, fast, powerful node.js web framework (@cli) |
| <img src="https://github.com/nestjs.png?size=40" width="20" height="20" alt=""> | [`@nestjs/schematics`](https://github.com/nestjs/schematics#readme) | MIT | Nest - modern, fast, powerful node.js web framework (@schematics) |
| <img src="https://github.com/nestjs.png?size=40" width="20" height="20" alt=""> | [`@nestjs/testing`](https://nestjs.com) | MIT | Nest - modern, fast, powerful node.js web framework (@testing) |
| <img src="https://github.com/microsoft.png?size=40" width="20" height="20" alt=""> | [`@playwright/test`](https://playwright.dev) | Apache-2.0 | A high-level API to automate web browsers |
| <img src="https://github.com/remix-run.png?size=40" width="20" height="20" alt=""> | [`@react-router/dev`](https://reactrouter.com) | MIT | Dev tools and CLI for React Router |
| <img src="https://github.com/swc-project.png?size=40" width="20" height="20" alt=""> | [`@swc/core`](https://swc.rs) | Apache-2.0 | Super-fast alternative for babel |
| <img src="https://github.com/tailwindlabs.png?size=40" width="20" height="20" alt=""> | [`@tailwindcss/typography`](https://github.com/tailwindlabs/tailwindcss-typography#readme) | MIT | A Tailwind CSS plugin for automatically styling plain HTML content with beautiful typographi |
| <img src="https://github.com/tailwindlabs.png?size=40" width="20" height="20" alt=""> | [`@tailwindcss/vite`](https://tailwindcss.com) | MIT | A utility-first CSS framework for rapidly building custom user interfaces. |
| <img src="https://github.com/tauri-apps.png?size=40" width="20" height="20" alt=""> | [`@tauri-apps/cli`](https://github.com/tauri-apps/tauri#readme) | Apache-2.0 OR MIT | Command line interface for building Tauri apps |
| <img src="https://github.com/testing-library.png?size=40" width="20" height="20" alt=""> | [`@testing-library/dom`](https://github.com/testing-library/dom-testing-library#readme) | MIT | Simple and complete DOM testing utilities that encourage good testing practices. |
| <img src="https://github.com/testing-library.png?size=40" width="20" height="20" alt=""> | [`@testing-library/jest-dom`](https://github.com/testing-library/jest-dom#readme) | MIT | Custom jest matchers to test the state of the DOM |
| <img src="https://github.com/testing-library.png?size=40" width="20" height="20" alt=""> | [`@testing-library/react`](https://github.com/testing-library/react-testing-library#readme) | MIT | Simple and complete React DOM testing utilities that encourage good testing practices. |
| <img src="https://github.com/testing-library.png?size=40" width="20" height="20" alt=""> | [`@testing-library/user-event`](https://github.com/testing-library/user-event#readme) | MIT | Fire events the same way the user does |
| <img src="https://github.com/total-typescript.png?size=40" width="20" height="20" alt=""> | [`@total-typescript/shoehorn`](https://github.com/total-typescript/shoehorn#readme) | MIT | Work seamlessly with partial mocks in TypeScript. |
| <img src="https://github.com/DefinitelyTyped.png?size=40" width="20" height="20" alt=""> | [`@types/cookie-parser`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | TypeScript definitions for cookie-parser |
| <img src="https://github.com/DefinitelyTyped.png?size=40" width="20" height="20" alt=""> | [`@types/dockerode`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | TypeScript definitions for dockerode |
| <img src="https://github.com/DefinitelyTyped.png?size=40" width="20" height="20" alt=""> | [`@types/express`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | TypeScript definitions for express |
| <img src="https://github.com/DefinitelyTyped.png?size=40" width="20" height="20" alt=""> | [`@types/jsonwebtoken`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | TypeScript definitions for jsonwebtoken |
| <img src="https://github.com/DefinitelyTyped.png?size=40" width="20" height="20" alt=""> | [`@types/node`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | TypeScript definitions for node |
| <img src="https://github.com/DefinitelyTyped.png?size=40" width="20" height="20" alt=""> | [`@types/pg`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | TypeScript definitions for pg |
| <img src="https://github.com/DefinitelyTyped.png?size=40" width="20" height="20" alt=""> | [`@types/react`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | TypeScript definitions for react |
| <img src="https://github.com/DefinitelyTyped.png?size=40" width="20" height="20" alt=""> | [`@types/react-dom`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | TypeScript definitions for react-dom |
| <img src="https://github.com/DefinitelyTyped.png?size=40" width="20" height="20" alt=""> | [`@types/semver`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | TypeScript definitions for semver |
| <img src="https://github.com/DefinitelyTyped.png?size=40" width="20" height="20" alt=""> | [`@types/validator`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | TypeScript definitions for validator |
| <img src="https://github.com/DefinitelyTyped.png?size=40" width="20" height="20" alt=""> | [`@types/web-push`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | TypeScript definitions for web-push |
| <img src="https://github.com/vitest-dev.png?size=40" width="20" height="20" alt=""> | [`@vitest/coverage-v8`](https://vitest.dev/guide/coverage) | MIT | V8 coverage provider for Vitest |
| <img src="https://github.com/cloudflare.png?size=40" width="20" height="20" alt=""> | [`cloudflare`](https://github.com/cloudflare/cloudflare-typescript#readme) | Apache-2.0 | The official TypeScript library for the Cloudflare API |
| <img src="https://github.com/entropitor.png?size=40" width="20" height="20" alt=""> | [`dotenv-cli`](https://github.com/entropitor/dotenv-cli) | MIT | A global executable to run applications with the ENV variables loaded by dotenv |
| <img src="https://github.com/drizzle-team.png?size=40" width="20" height="20" alt=""> | [`drizzle-kit`](https://orm.drizzle.team) | MIT | Drizzle Kit is a CLI migrator tool for Drizzle ORM. It is probably the one and only tool tha |
| <img src="https://github.com/evanw.png?size=40" width="20" height="20" alt=""> | [`esbuild`](https://github.com/evanw/esbuild#readme) | MIT | An extremely fast JavaScript and CSS bundler and minifier. |
| <img src="https://github.com/typicode.png?size=40" width="20" height="20" alt=""> | [`husky`](https://github.com/typicode/husky#readme) | MIT | Modern native Git hooks |
| <img src="https://github.com/jsdom.png?size=40" width="20" height="20" alt=""> | [`jsdom`](https://github.com/jsdom/jsdom#readme) | MIT | A JavaScript implementation of many web standards |
| <img src="https://github.com/webpro-nl.png?size=40" width="20" height="20" alt=""> | [`knip`](https://knip.dev) | ISC | Find and fix unused dependencies, exports and files in your TypeScript and JavaScript projec |
| <img src="https://github.com/lint-staged.png?size=40" width="20" height="20" alt=""> | [`lint-staged`](https://github.com/lint-staged/lint-staged#readme) | MIT | Lint files staged by git |
| <img src="https://github.com/streamich.png?size=40" width="20" height="20" alt=""> | [`memfs`](https://github.com/streamich/memfs) | Apache-2.0 | In-memory file-system with Node's fs API. |
| <img src="https://github.com/mapbox.png?size=40" width="20" height="20" alt=""> | [`pixelmatch`](https://github.com/mapbox/pixelmatch#readme) | ISC | The smallest and fastest pixel-level image comparison library. |
| <img src="https://github.com/pngjs.png?size=40" width="20" height="20" alt=""> | [`pngjs`](https://github.com/lukeapage/pngjs) | MIT | PNG encoder/decoder in pure JS, supporting any bit size & interlace, async & sync with full  |
|  | [`tailwindcss-animate`](https://www.npmjs.com/package/tailwindcss-animate) | MIT | A Tailwind CSS plugin for creating beautiful animations. |
| <img src="https://github.com/TypeStrong.png?size=40" width="20" height="20" alt=""> | [`ts-node`](https://typestrong.org/ts-node) | MIT | TypeScript execution environment and REPL for node.js, with source map support |
| <img src="https://github.com/vercel.png?size=40" width="20" height="20" alt=""> | [`turbo`](https://turborepo.dev) | MIT | Turborepo is the build system for coding agents. |
| <img src="https://github.com/unplugin.png?size=40" width="20" height="20" alt=""> | [`unplugin-swc`](https://github.com/unplugin/unplugin-swc) | MIT | SWC plugin for Vite and Rollup |
| <img src="https://github.com/aleclarson.png?size=40" width="20" height="20" alt=""> | [`vite-tsconfig-paths`](https://github.com/aleclarson/vite-tsconfig-paths#readme) | MIT | Vite resolver for TypeScript compilerOptions.paths |
| <img src="https://github.com/vitest-dev.png?size=40" width="20" height="20" alt=""> | [`vitest`](https://vitest.dev) | MIT | Next generation testing framework powered by Vite |
| <img src="https://github.com/eratio08.png?size=40" width="20" height="20" alt=""> | [`vitest-mock-extended`](https://github.com/eratio08/vitest-mock-extended) | MIT | Type safe mocking extensions for vitest, forked from jest-mock-extended |
| <img src="https://github.com/TheBrainFamily.png?size=40" width="20" height="20" alt=""> | [`wait-for-expect`](https://github.com/TheBrainFamily/wait-for-expect#readme) | MIT | Wait for expectation to be true, useful for integration and end to end testing |

---

Thank you to everyone who maintains these projects.

---

_Generated by [`scripts/generate-attribution.mjs`](https://github.com/companionintelligence/CI-Engineering/blob/main/scripts/generate-attribution.mjs) for `CI-Hub`. Regenerate rather than editing generated sections by hand._
