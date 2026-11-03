import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    pool: "forks",
    
    
    teardownTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      
      
      
      
      exclude: ["src/cli.ts", "src/cli-version.ts", "src/policies/sandboxRunner.ts"],
      
      
      // Raised to match the current suite (92/96/92/86) with a small cushion
      // so a real regression fails CI while unrelated churn does not.
      thresholds: {
        lines: 90,
        functions: 92,
        statements: 90,
        branches: 84
      }
    }
  }
});
