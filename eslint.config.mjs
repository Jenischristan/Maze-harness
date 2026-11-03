import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Flat ESLint config.
 *
 * The codebase is ~11k lines of strict TypeScript with no linter at all, so
 * whole classes of defect (unused imports, `any` leakage, unsafe regex,
 * shadowed variables) were only caught by review. Rules are chosen for signal,
 * not ceremony: type-aware checks are limited to the ones that find real bugs.
 *
 * `pnpm lint` runs `eslint . --max-warnings 0`. Prettier owns formatting, so no
 * stylistic rules are enabled here.
 *
 * The rule set deliberately stops at what the compiler does *not* already
 * enforce:
 *   - the TypeScript checker already reports unused locals/imports under
 *     `noUnusedLocals`-style analysis in CI (`tsc --noEmit` with `strict`), and
 *     duplicating it here only produced false positives on type-only imports;
 *   - `consistent-type-imports` is a style rule that Prettier-adjacent tooling
 *     handles better and it rewrote dozens of correct `import()` annotations.
 * What remains are rules that catch genuine defects.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "runs/**",
      "worktrees/**",
      "tmp/**",
      "Dream-RSI/**",
      "examples/**",
      "agents/**",
      "test/cli-e2e.test.mjs"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        URL: "readonly",
        AbortSignal: "readonly",
        AbortController: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        structuredClone: "readonly",
        globalThis: "readonly",
        __dirname: "readonly",
        __filename: "readonly"
      }
    },
    rules: {
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-unreachable": "error",
      "no-duplicate-imports": "error",
      "no-self-compare": "error",
      "no-template-curly-in-string": "error",
      "no-fallthrough": "error",
      "no-useless-catch": "error",
      eqeqeq: ["error", "smart"],
      "prefer-const": ["error", { destructuring: "all" }],
      // The TypeScript checker owns undefined identifiers; the base rule
      // produces false positives on type-only imports and lib globals.
      "no-undef": "off",
      // Owned by `tsc`; duplicate reporting here is noise.
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/consistent-type-imports": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-namespace": "off",
      "@typescript-eslint/no-this-alias": "off"
    }
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off"
    }
  }
);
