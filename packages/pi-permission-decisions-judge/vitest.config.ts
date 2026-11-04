import { defineConfig } from "vitest/config";

export default defineConfig({
  // `#src/*` and `#test/*` resolve through this package's own `imports` map in
  // package.json. An explicit `resolve.alias` here would also match the
  // dependency's internal `#src/...` specifiers — the hub ships its `.` entry as
  // `src/service.ts`, so the alias breaks every test that imports a hub value.
  test: {
    include: ["test/**/*.test.ts"],
  },
});
