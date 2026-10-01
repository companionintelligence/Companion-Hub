/**
 * psl ships types/index.d.ts, but its package.json `exports` has no `types`
 * condition. The `node10` resolver found them through the top-level `types`
 * field; `bundler` (TypeScript 7 removed `node10`) follows `exports` only and
 * finds none. These mirror the upstream declarations for psl 1.x.
 */
declare module 'psl' {
  export type ErrorResult = {
    input: string;
    error: {
      code: string;
      message: string;
    };
  };

  export type ParsedDomain = {
    input: string;
    tld: string | null;
    sld: string | null;
    domain: string | null;
    subdomain: string | null;
    listed: boolean;
  };

  export function parse(input: string): ParsedDomain | ErrorResult;
  export function get(domain: string): string | null;
  export function isValid(domain: string): boolean;
}
