import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // Never scan Glint's own runtime state (backups/memory) — running glint in
    // this repo creates .glint/, and a backed-up copy of a test file would
    // otherwise be picked up with a broken relative import.
    exclude: [...configDefaults.exclude, "**/.glint/**"],
  },
});
