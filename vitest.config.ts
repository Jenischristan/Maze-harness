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
      
      
      thresholds: {
        lines: 60,
        functions: 60,
        statements: 60,
        branches: 55
      }
    }
  }
});
