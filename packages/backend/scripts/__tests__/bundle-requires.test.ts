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

  it('leaves files without a module-level require binding alone', () => {
    expect(stripLocalCreateRequire("export const x = require('y');")).toBeUndefined();
    // @nestjs/common's dynamic fallback: no binding, and nothing esbuild could bundle anyway.
    expect(stripLocalCreateRequire('const pkg = loaderFn ? loaderFn() : createRequire(import.meta.url)(packageName);')).toBeUndefined();
    expect(stripLocalCreateRequire('const req = createRequire(import.meta.url);')).toBeUndefined();
  });
});

describe('bundleLocalRequires with esbuild', () => {
  let root: string;

  beforeAll(async () => {
    // node_modules/esm-pkg is laid out like @nestjs/serve-static 12: ESM, loading a CommonJS
    // dependency through its own createRequire.
    root = await mkdtemp(join(tmpdir(), 'bundle-requires-'));
    await mkdir(join(root, 'node_modules/dep'), { recursive: true });
    await mkdir(join(root, 'node_modules/esm-pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules/dep/package.json'), JSON.stringify({ name: 'dep', main: 'index.js' }));
    await writeFile(join(root, 'node_modules/dep/index.js'), "module.exports = 'dep-was-bundled';\n");
    await writeFile(join(root, 'node_modules/esm-pkg/package.json'), JSON.stringify({ name: 'esm-pkg', type: 'module', main: 'index.js' }));
    await writeFile(
      join(root, 'node_modules/esm-pkg/index.js'),
      [
        "import { createRequire } from 'node:module';",
        'const require = createRequire(import.meta.url);',
        "export const load = () => require('dep');",
        '',
      ].join('\n'),
    );
    await writeFile(join(root, 'entry.js'), "import { load } from 'esm-pkg';\nconsole.log(load());\n");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const bundle = async (plugins: Parameters<typeof build>[0]['plugins']) => {
    const result = await build({
      entryPoints: [join(root, 'entry.js')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      logLevel: 'silent',
      plugins,
    });
    return result.outputFiles[0]?.text ?? '';
  };

  it('without the plugin, esbuild leaves the dependency as a runtime lookup', async () => {
    const output = await bundle([]);

    expect(output).not.toContain('dep-was-bundled');
    expect(findRuntimeLookups(output).map(({ specifier }) => specifier)).toContain('dep');
  });

  it('with the plugin, the dependency is compiled into the bundle', async () => {
    const output = await bundle([bundleLocalRequires]);

    expect(output).toContain('dep-was-bundled');
    expect(findRuntimeLookups(output)).toEqual([]);
  });
});
