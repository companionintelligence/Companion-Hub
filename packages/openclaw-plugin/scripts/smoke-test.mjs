#!/usr/bin/env -S deno run --allow-net --allow-env
// Runtime parity smoke test — NOT part of the package's build output.
//
// Calls register() with a mock OpenClaw host api, the same way the real host would,
// and asserts on the observed side effects (registered routes, log lines, wake calls).
// Run identically under node (against the esbuild .mjs bundle) and deno (against the
// raw TypeScript source) to compare real runtime behavior, not just type-checking.
//
// Usage (from packages/openclaw-plugin; the module path is resolved relative to THIS
// file, i.e. scripts/, not to the caller's cwd):
//   node scripts/bundle-to-openclaw.mjs && node scripts/smoke-test.mjs ../dist/hub-plugin.mjs   # esbuild/node baseline
//   deno run -A scripts/smoke-test.mjs ../src/index.ts                                           # deno, direct from source, no build step
//   deno task smoke                                                                              # same as above, via deno.json

const isDeno = typeof Deno !== 'undefined';
const modulePath = isDeno ? Deno.args[0] : process.argv[2];
if (!modulePath) {
  console.error('Usage: smoke-test.mjs <path-to-plugin-module>');
  (isDeno ? Deno : process).exit(1);
}

const { register } = await import(modulePath);

const calls = { routes: [], logs: [], wakes: [] };
const api = {
  registerTool: () => {
    // Not exercised by this smoke test — register() calls it, but nothing here asserts on it.
  },
  registerHttpRoute: (route) => calls.routes.push(route.path),
  wake: (message) => calls.wakes.push(message),
  log: {
    info: (m) => calls.logs.push(['info', m]),
    warn: (m) => calls.logs.push(['warn', m]),
    error: (m) => calls.logs.push(['error', m]),
    debug: (m) => calls.logs.push(['debug', m]),
  },
};

register(api, { hubUrl: 'http://hub.invalid:9999', wakeSecret: 'test-secret', sseEnabled: false });

const assertions = [
  ['registered wake route', calls.routes.includes('/hooks/hub-wake')],
  ['logged hub init message', calls.logs.some(([, m]) => m.includes('CI-Hub plugin initializing'))],
  ['logged wake endpoint registration', calls.logs.some(([, m]) => m.includes('Registered wake endpoint'))],
];

let failed = false;
for (const [name, ok] of assertions) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}`);
  if (!ok) failed = true;
}

(isDeno ? Deno : process).exit(failed ? 1 : 0);
