import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // Never scan Super Terminal's own runtime state (backups/memory) — running super-t in
    // this repo creates .super-t/, and a backed-up copy of a test file would
    // otherwise be picked up with a broken relative import.
    exclude: [...configDefaults.exclude, "**/.super-t/**"],
  },
});
