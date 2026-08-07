import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dynamicComposeFormSchema, toJsonSchema } from '@ci-hub/common/schemas';
import { describe, expect, it } from 'vitest';

/**
 * Regression guards for the crash that took `/apps/create` down twice.
 *
 * Zod 4 throws "`.omit()` cannot be used on object schemas containing
 * refinements" when `.omit()` is called on a schema carrying refinements, and
 * `dynamicComposeSchema` ends in `.superRefine(assertComposeOverrideSecurity)`.
 *
 * The nasty part is *where* it throws. `json-compose-editor.tsx` made that call
 * at MODULE SCOPE, and `multi-service-form.tsx` imports that module statically,
 * so the throw happened as soon as the `/apps/create` chunk was evaluated —
 * before any component rendered. React Router treated the failed route module
 * as a load error and retried forever: empty `<body>`, ~144 main-frame
 * navigations in 9s, and no error boundary ever ran.
 *
 * PR #1065 fixed one of three call sites; the other two survived and the route
 * stayed dead. Hence a source-level guard rather than a render test — the point
 * is that NO call site anywhere in the frontend reintroduces the pattern, and
 * two of the three could not be caught by rendering the create page at all
 * (`multiServiceStore.validate` and the custom-app *edit* page throw on use).
 *
 * Callers that need the shape without `schemaVersion` must use
 * `dynamicComposeFormSchema`, which derives from the unrefined
 * `dynamicComposeObject` and re-applies the security refinement.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../..');

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry)) yield full;
  }
}

describe('dynamic compose schema usage', () => {
  it('never calls .omit() on the refined dynamicComposeSchema anywhere in the frontend', () => {
    // Matches `dynamicComposeSchema.omit(` across line breaks/whitespace.
    const forbidden = /dynamicComposeSchema\s*\.\s*omit\s*\(/;
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      // Don't flag this guard's own description of the pattern.
      if (file === fileURLToPath(import.meta.url)) continue;
      if (forbidden.test(readFileSync(file, 'utf8'))) {
        offenders.push(path.relative(SRC, file));
      }
    }

    expect(
      offenders,
      `.omit() on the refined dynamicComposeSchema throws at runtime and kills /apps/create. Use dynamicComposeFormSchema instead. Offending files: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('builds a JSON schema from the form schema without throwing', () => {
    // The exact module-scope call in json-compose-editor.tsx that crashed the route.
    expect(() => toJsonSchema(dynamicComposeFormSchema)).not.toThrow();
    expect(toJsonSchema(dynamicComposeFormSchema)).toMatchObject({ type: 'object' });
  });

  it('validates a compose payload that omits schemaVersion', () => {
    const result = dynamicComposeFormSchema.safeParse({
      services: [{ name: 'web', image: 'nginx:latest', isMain: true }],
    });

    expect(result.success).toBe(true);
  });

  it('still rejects an invalid compose payload', () => {
    expect(dynamicComposeFormSchema.safeParse({ services: [] }).success).toBe(false);
  });
});
