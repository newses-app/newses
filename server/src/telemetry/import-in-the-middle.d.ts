// The package types this entry point as register-hooks.d.ts, which TypeScript does not pair with .mjs.
declare module 'import-in-the-middle/register-hooks.mjs' {
  export function register(options?: {
    include?: (string | RegExp)[];
    exclude?: (string | RegExp)[];
  }): void;
}
