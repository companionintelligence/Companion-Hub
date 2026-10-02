import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundleLocalRequires, checkBundle, findRuntimeLookups, stripLocalCreateRequire } from '../bundle-requires';

// The shape esbuild gave @nestjs/serve-static 12's ExpressLoader in the bundle that crash-looped on
// the fleet: the package's own `require` renamed to require5, its express lookup left for runtime.
const brokenServeStatic = [
  'var __decorate19, ExpressLoader_1, require5, ExpressLoader;',
  'var init_express_loader = __esm({',
  '  "node_modules/@nestjs/serve-static/dist/loaders/express.loader.js"() {',
  '    require5 = createRequire5(import.meta.url);',
  '    ExpressLoader = ExpressLoader_1 = class ExpressLoader extends AbstractLoader {',
  '      register(httpAdapter, config, optionsArr) {',
  '        const express2 = loadPackageSync("express", "ServeStaticModule", () => require5("express"));',
].join('\n');

// The same module once the plugin let esbuild see through the local require.
const fixedServeStatic = [
  'var __decorate19, ExpressLoader_1, ExpressLoader;',
  'var init_express_loader = __esm({',
  '  "node_modules/@nestjs/serve-static/dist/loaders/express.loader.js"() {',
  '    ExpressLoader = ExpressLoader_1 = class ExpressLoader extends AbstractLoader {',
  '      register(httpAdapter, config, optionsArr) {',
  '        const express2 = loadPackageSync("express", "ServeStaticModule", () => require_express4());',
].join('\n');

const externals = ['pg', 'class-transformer', '@fastify/static'];

describe('checkBundle', () => {
  it('fails a bundle that still loads express through a renamed local require', () => {
    const { unexpected } = checkBundle(brokenServeStatic, externals, {});

    expect(unexpected).toEqual([{ specifier: 'express', via: 'require5', line: 7 }]);
  });

  it('passes the same module once express is compiled in', () => {
    expect(checkBundle(fixedServeStatic, externals, {}).unexpected).toEqual([]);
  });

  it('reports a renamed require even when its createRequire binding is not in the text', () => {
    const { unexpected } = checkBundle('const m = require7("class-validator");', externals, {});

    expect(unexpected).toEqual([{ specifier: 'class-validator', via: 'require7', line: 1 }]);
  });

  it('reports a call through any name bound to createRequire, not just requireN', () => {
    const bundle = ['const req = createRequire(import.meta.url);', 'const x = req("swagger-ui-dist/absolute-path.js");'].join('\n');

    expect(checkBundle(bundle, externals, {}).unexpected).toEqual([{ specifier: 'swagger-ui-dist/absolute-path.js', via: 'req', line: 2 }]);
  });

  it('reports createRequire called in place, the loader shape @nestjs/common 12 recommends', () => {
    const bundle = [
      // What esbuild leaves of `() => createRequire(import.meta.url)('pkg')` without the plugin.
      'var a = () => createRequire(import.meta.url)("express");',
      // Sentry 11's Mastra integration, as it sits in the Hub bundle.
      '        return node_module.createRequire(parent)("@mastra/observability");',
      'var c = __require("module").createRequire(__filename).resolve("class-validator/package.json");',
    ].join('\n');

    expect(checkBundle(bundle, externals, {}).unexpected).toEqual([
      { specifier: 'express', via: 'createRequire(import.meta.url)', line: 1 },
      { specifier: '@mastra/observability', via: 'node_module.createRequire(parent)', line: 2 },
      { specifier: 'class-validator/package.json', via: 'createRequire(__filename)', line: 3 },
    ]);
  });

  it('follows createRequire through an import alias or a destructuring rename', () => {
    const bundle = [
      'import { createRequire as cr } from "module";',
      'var r = cr(import.meta.url);',
      'var b = () => r("express");',
      'var d = () => cr(import.meta.url)("class-validator");',
      'var { createRequire: make } = __require("node:module");',
      'var e = make(__filename)("@nestjs/swagger");',
    ].join('\n');

    expect(checkBundle(bundle, externals, {}).unexpected).toEqual([
      { specifier: 'express', via: 'r', line: 3 },
      { specifier: 'class-validator', via: 'cr(import.meta.url)', line: 4 },
      { specifier: '@nestjs/swagger', via: 'make(__filename)', line: 6 },
    ]);
  });

  it('does not take an object literal key named createRequire for an alias', () => {
    const bundle = ['var api = { createRequire: helper, other: 1 };', 'var x = helper(a)("not-a-module");'].join('\n');

    expect(findRuntimeLookups(bundle)).toEqual([]);
  });

  it('accepts builtins, declared externals and their subpaths, and allowlisted specifiers', () => {
    const bundle = [
      'var a = __require("node:fs");',
      'var b = __require("fs/promises");',
      'var c = __require("pg");',
      'var d = __require("class-transformer/cjs/storage");',
      'var e = __require("osx-temperature-sensor");',
      'var f = await import("@fastify/static");',
    ].join('\n');

    const result = checkBundle(bundle, externals, { 'osx-temperature-sensor': 'optional, in try/catch' });

    expect(result).toEqual({ unexpected: [], unusedAllowlist: [] });
  });

  it('does not let a trailing-slash specifier pass as the builtin it shadows', () => {
    // Node refuses require('process/'): the slash rules out the builtin and asks for the npm shim.
    const { unexpected } = checkBundle('var process2 = __require("process/");', externals, {});

    expect(unexpected.map(({ specifier }) => specifier)).toEqual(['process/']);
  });

  it('reports a dynamic import of a package that is neither bundled nor external', () => {
    const { unexpected } = checkBundle('const m = await import("express");', externals, {});

    expect(unexpected).toEqual([{ specifier: 'express', via: 'import', line: 1 }]);
  });

  it('lists allowlist entries the bundle no longer loads', () => {
    expect(checkBundle(fixedServeStatic, externals, { 'macos-temperature-sensor': 'gone' }).unusedAllowlist).toEqual(['macos-temperature-sensor']);
  });
});

describe('findRuntimeLookups', () => {
  it('ignores require and import text inside strings, templates and comments', () => {
    const bundle = [
      // ajv's standalone code generation
      `      equal.code = 'require("ajv/dist/runtime/equal").default';`,
      '      (_b.formats = (0, codegen_1._)`require("ajv-formats/dist/formats").${exportName}`);',
      '      const dc = moduleType === "esm" ? `import x from "${dcModule}"` : `const x = require("${dcModule}")`;',
      // JSDoc types
      "       * @param {import('estree').Program} node - The program root node.",
      "      /** @type {import('./get')} */",
      "      objects.next = /** @type {import('./list.d.ts').ListNode} */ value;",
      '      // const express = require("express");',
      // a non-literal lookup has nothing to check
      '      var fn = __require(mod).__express;',
    ].join('\n');

    expect(findRuntimeLookups(bundle)).toEqual([]);
  });

  it('still reports a real call after a closed comment on the same line', () => {
    expect(findRuntimeLookups('var x = /* @__PURE__ */ __require("express");')).toEqual([{ specifier: 'express', via: '__require', line: 1 }]);
  });

  it('still reports a real call after a string that holds comment markers', () => {
    const bundle = ['var sep = " // "; var x = __require("express");', 'var glob = "lib/*.js"; var y = __require("class-validator");'].join('\n');

    expect(findRuntimeLookups(bundle)).toEqual([
      { specifier: 'express', via: '__require', line: 1 },
      { specifier: 'class-validator', via: '__require', line: 2 },
    ]);
  });

  it('reads a specifier quoted with backticks', () => {
    expect(findRuntimeLookups('var x = __require(`express`);')).toEqual([{ specifier: 'express', via: '__require', line: 1 }]);
  });

  it('does not mistake esbuild helpers that end in "require" for the renamed ones', () => {
    const bundle = ['var __commonJS = (cb, mod) => function __require2() {', '  var _require2 = __require("util");', '};'].join('\n');

    expect(findRuntimeLookups(bundle)).toEqual([{ specifier: 'util', via: '__require', line: 2 }]);
  });
});

describe('stripLocalCreateRequire', () => {
  it("removes an ESM package's own require binding and keeps the line count", () => {
    const source = [
      "import { createRequire } from 'module';",
      "import { loadPackageSync } from '@nestjs/common/utils/load-package.util.js';",
      'const require = createRequire(import.meta.url);',
      "export const load = () => loadPackageSync('express', 'ServeStaticModule', () => require('express'));",
    ].join('\n');

    const stripped = stripLocalCreateRequire(source);

    expect(stripped).toBeDefined();
    expect(stripped).not.toMatch(/const require =/);
    expect(stripped).toContain("() => require('express')");
    expect(stripped?.split('\n')).toHaveLength(4);
  });

  it('handles the node:module spelling and a namespaced createRequire', () => {
    expect(stripLocalCreateRequire('const require = module.createRequire(import.meta.url);\nrequire("x");')).not.toMatch(/createRequire\(/);
  });

  it('turns createRequire called in place with a literal specifier into a plain require', () => {
    const source = [
      "import { createRequire } from 'node:module';",
      "import * as nodeModule from 'node:module';",
      "export const a = () => loadPackageSync('express', 'ServeStaticModule', () => createRequire(import.meta.url)('express'));",
      'export const b = () => nodeModule.createRequire( import.meta.url ) ("class-validator");',
    ].join('\n');

    const stripped = stripLocalCreateRequire(source);

    expect(stripped?.split('\n')).toEqual([
      "import { createRequire } from 'node:module';",
      "import * as nodeModule from 'node:module';",
      "export const a = () => loadPackageSync('express', 'ServeStaticModule', () => require('express'));",
      'export const b = () => require ("class-validator");',
    ]);
  });

  it('leaves files without a module-level require binding alone', () => {
    expect(stripLocalCreateRequire("export const x = require('y');")).toBeUndefined();
    // @nestjs/common's dynamic fallback: no binding, and nothing esbuild could bundle anyway.
    expect(stripLocalCreateRequire('const pkg = loaderFn ? loaderFn() : createRequire(import.meta.url)(packageName);')).toBeUndefined();
    expect(stripLocalCreateRequire('const req = createRequire(import.meta.url);')).toBeUndefined();
  });
});

describe('bundleLocalRequires with esbuild', () => {
  let root: string;

  // Each package is ESM and loads the CommonJS `dep` through createRequire, one shape per package.
  const packages: Record<string, string[]> = {
    // @nestjs/serve-static 12: a module-level `require` of its own.
    'esm-pkg': [
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      "export const load = () => require('dep');",
    ],
    // The loader @nestjs/common 12's loadPackageSync JSDoc recommends: createRequire called in place.
    'inline-pkg': ["import { createRequire } from 'node:module';", "export const load = () => createRequire(import.meta.url)('dep');"],
    // An aliased createRequire bound to another name, which the plugin does not rewrite.
    'alias-pkg': ["import { createRequire as cr } from 'module';", 'const r = cr(import.meta.url);', "export const load = () => r('dep');"],
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bundle-requires-'));
    await mkdir(join(root, 'node_modules/dep'), { recursive: true });
    await writeFile(join(root, 'node_modules/dep/package.json'), JSON.stringify({ name: 'dep', main: 'index.js' }));
    await writeFile(join(root, 'node_modules/dep/index.js'), "module.exports = 'dep-was-bundled';\n");
    for (const [name, lines] of Object.entries(packages)) {
      await mkdir(join(root, 'node_modules', name), { recursive: true });
      await writeFile(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' }));
      await writeFile(join(root, 'node_modules', name, 'index.js'), `${lines.join('\n')}\n`);
      await writeFile(join(root, `${name}.entry.js`), `import { load } from '${name}';\nconsole.log(load());\n`);
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const bundle = async (pkg: string, plugins: Parameters<typeof build>[0]['plugins']) => {
    const result = await build({
      entryPoints: [join(root, `${pkg}.entry.js`)],
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      logLevel: 'silent',
      plugins,
    });
    return result.outputFiles[0]?.text ?? '';
  };

  it.each(Object.keys(packages))('without the plugin, esbuild leaves the dependency of %s as a runtime lookup the check reports', async (pkg) => {
    const output = await bundle(pkg, []);

    expect(output).not.toContain('dep-was-bundled');
    expect(checkBundle(output, [], {}).unexpected.map(({ specifier }) => specifier)).toEqual(['dep']);
  });

  it.each(['esm-pkg', 'inline-pkg'])('with the plugin, the dependency of %s is compiled into the bundle', async (pkg) => {
    const output = await bundle(pkg, [bundleLocalRequires]);

    expect(output).toContain('dep-was-bundled');
    expect(findRuntimeLookups(output)).toEqual([]);
  });

  it('with the plugin, an aliased createRequire still fails the check rather than shipping', async () => {
    const output = await bundle('alias-pkg', [bundleLocalRequires]);

    expect(output).not.toContain('dep-was-bundled');
    expect(checkBundle(output, [], {}).unexpected).toEqual([{ specifier: 'dep', via: 'r', line: expect.any(Number) }]);
  });
});
