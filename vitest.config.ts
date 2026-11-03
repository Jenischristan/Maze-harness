import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    pool: "forks",
    // A leaked MCP child or shell session used to keep the runner alive; fail
    // instead of hanging so CI does not stall on a stray handle.
    teardownTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      // `cli.ts` is commander wiring and is exercised end-to-end as a
      // subprocess; `sandboxRunner.ts` only runs inside a child process. Their
      // line coverage is not meaningful in-process, so they are excluded from
      // the threshold rather than covered with mocks that test the mock.
      exclude: ["src/cli.ts", "src/cli-version.ts", "src/policies/sandboxRunner.ts"],
      // Floor, not a target: the suite currently sits above this. It exists to
      // stop a future change from silently dropping a whole module's tests.
      thresholds: {
        lines: 60,
        functions: 60,
        statements: 60,
        branches: 55
      }
    }
  }
});
